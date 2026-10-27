import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "@commander-js/extra-typings";
import type { ConsoleLine } from "@delacour/warden-e2e/devtools/devtools.types";
import { type BrokerResult, brokerErr } from "../dev-broker/broker.types";
import { type DevSessionRecord, writeDevSession } from "../dev-session";
import { type TestContext, testContext } from "../testing";
import type { BrokerCall, BrokerClientDeps } from "./broker-client";
import {
	addLogpoint,
	clearLogpoints,
	listLogpoints,
	logpointHits,
	registerLogpoint,
	removeLogpoint,
} from "./logpoint-cli";

const contexts: TestContext[] = [];
afterEach(() => {
	for (const ctx of contexts.splice(0)) ctx.cleanup();
});

type Sent = { method: string; params: unknown };

const line = (ts: number, text: string, args?: string[]): ConsoleLine => ({
	ts,
	level: "log",
	kind: "console",
	text,
	...(args === undefined ? {} : { args }),
});

/** A ctx with one registered dev session and a broker stub that records what it is asked. */
type Handler = (method: string, params: unknown) => Promise<BrokerResult<unknown> | undefined> | undefined;

function rig(handle: Handler = () => undefined) {
	const ctx = testContext([]);
	contexts.push(ctx);
	const record: DevSessionRecord = {
		version: 1,
		leaseId: "lease-1",
		pid: process.pid,
		platform: "ios",
		deviceId: "UDID-1",
		port: 8081,
		metroUrl: "http://localhost:8081",
		logDir: "/logs",
		projectRoot: "/p",
		startedAt: "2026-10-27T00:00:00.000Z",
		brokerSocket: "/tmp/b.sock",
	};
	writeDevSession(ctx.env, record);
	const sent: Sent[] = [];
	const answer = async (method: string, params: unknown): Promise<BrokerResult<unknown>> => {
		sent.push({ method, params });
		if (method === "status") return { success: true, data: {} };
		return (await handle(method, params)) ?? { success: true, data: {} };
	};
	const call = ((_socket: string, request: { method: string; params?: unknown }) =>
		answer(request.method, request.params)) as BrokerCall;
	const deps: BrokerClientDeps = { isAlive: () => true, call };
	return { ctx, deps, sent, target: { env: ctx.env } };
}

const info = { id: "lp1", location: "src/a.ts:2", expression: "n", hitCount: 0, armed: true };

describe("work functions", () => {
	test("add / list / remove / clear send the logpoint.* methods", async () => {
		const r = rig((method) => {
			if (method === "logpoint.add") return Promise.resolve({ success: true, data: { logpoint: info } });
			if (method === "logpoint.list") return Promise.resolve({ success: true, data: { logpoints: [info] } });
			if (method === "logpoint.remove") return Promise.resolve({ success: true, data: { removed: "lp1" } });
			return Promise.resolve({ success: true, data: { removed: ["lp1"] } });
		});
		const params = { location: "src/a.ts:2", expression: "n", hits: 3 };
		expect(await addLogpoint(r.target, params, r.deps)).toEqual({ success: true, data: { logpoint: info } });
		expect(await listLogpoints(r.target, r.deps)).toEqual({ success: true, data: { logpoints: [info] } });
		expect(await removeLogpoint(r.target, { id: "lp1" }, r.deps)).toEqual({ success: true, data: { removed: "lp1" } });
		expect(await clearLogpoints(r.target, r.deps)).toEqual({ success: true, data: { removed: ["lp1"] } });
		expect(r.sent.filter((s) => s.method !== "status")).toEqual([
			{ method: "logpoint.add", params },
			{ method: "logpoint.list", params: {} },
			{ method: "logpoint.remove", params: { id: "lp1" } },
			{ method: "logpoint.clear", params: {} },
		]);
	});

	test("a broker error becomes a ui error", async () => {
		const r = rig(async () => brokerErr("logpoints_unsupported", "legacy", "use eval"));
		const added = await addLogpoint(r.target, { location: "a.ts:1", expression: "1" }, r.deps);
		expect(added.success).toBe(false);
		if (added.success) return;
		expect(added.error.message).toContain("legacy");
		expect(added.error.hint).toBe("use eval");
	});

	test("no dev session is devtools_unavailable with the start hint", async () => {
		const ctx = testContext([]);
		contexts.push(ctx);
		const added = await addLogpoint({ env: ctx.env }, { location: "a.ts:1", expression: "1" }, { isAlive: () => true });
		expect(!added.success && added.error.code).toBe("devtools_unavailable");
		expect(!added.success && added.error.hint).toContain("warden dev");
	});

	test("hits are the tagged console lines, split into value and error", async () => {
		const r = rig(async (method) =>
			method === "console.query"
				? {
						success: true,
						data: {
							total: 3,
							lines: [
								line(1, "[logpoint:a] 42", ["[logpoint:a]", "42"]),
								line(2, "[logpoint:b] error ReferenceError: x"),
								line(3, '[logpoint:a] {"k":1}'),
							],
						},
					}
				: undefined
		);
		const all = await logpointHits(r.target, {}, r.deps);
		expect(all.success && all.data.hits.map((h) => [h.id, h.value, h.error])).toEqual([
			["a", "42", false],
			["b", "ReferenceError: x", true],
			["a", '{"k":1}', false],
		]);
		const only = await logpointHits(r.target, { id: "a", since: 5, limit: 10 }, r.deps);
		expect(only.success && only.data.hits).toHaveLength(2);
		expect(r.sent.at(-1)).toEqual({
			method: "console.query",
			params: { grep: "[logpoint:a]", since: 5, kind: "console", limit: 10 },
		});
	});
});

describe("registerLogpoint", () => {
	async function run(r: ReturnType<typeof rig>, argv: string[]): Promise<number> {
		let code = -1;
		const program = new Command().exitOverride();
		registerLogpoint(
			program,
			r.ctx,
			(c) => {
				code = c;
			},
			r.deps
		);
		await program.parseAsync(["logpoint", ...argv], { from: "user" });
		return code;
	}

	test("add prints one JSON envelope with --json", async () => {
		const r = rig(async (method) =>
			method === "logpoint.add" ? { success: true, data: { logpoint: info } } : undefined
		);
		const code = await run(r, ["add", "src/a.ts:2", "n", "--id", "lp1", "--hits", "3", "--json"]);
		expect(code).toBe(0);
		expect(r.sent.at(-1)).toEqual({
			method: "logpoint.add",
			params: { location: "src/a.ts:2", expression: "n", id: "lp1", hits: 3 },
		});
		const doc = JSON.parse(r.ctx.stdout.join("\n"));
		expect(doc).toMatchObject({
			ok: true,
			command: "logpoint add",
			device: { udid: "UDID-1" },
			result: { logpoint: info },
		});
	});

	test("list prints a row per logpoint, and `no logpoints` when empty", async () => {
		const r = rig(async (method) =>
			method === "logpoint.list" ? { success: true, data: { logpoints: [info] } } : undefined
		);
		expect(await run(r, ["list"])).toBe(0);
		expect(r.ctx.stdout.join("\n")).toContain("lp1  armed  src/a.ts:2  0 hits  n");
		const empty = rig(async () => ({ success: true, data: { logpoints: [] } }));
		await run(empty, ["list"]);
		expect(empty.ctx.stdout).toEqual(["no logpoints"]);
	});

	test("a bad --hits is a usage error and sends nothing", async () => {
		const r = rig();
		expect(await run(r, ["add", "src/a.ts:2", "n", "--hits", "0"])).toBe(1);
		expect(r.sent.filter((s) => s.method.startsWith("logpoint."))).toEqual([]);
		expect(r.ctx.stderr.join("\n")).toContain("--hits");
	});

	test("a failing broker exits non-zero with its hint", async () => {
		const r = rig(async () => brokerErr("logpoints_unsupported", "legacy", "use eval"));
		expect(await run(r, ["rm", "lp1"])).toBe(1);
		expect(r.ctx.stderr.join("\n")).toContain("use eval");
	});
});
