import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleLine, NetworkEntry } from "@delacour/warden-e2e/devtools/devtools.types";
import { ok } from "@delacour/warden-types/result";
import type { UiDeps } from "../agent-ui/driver";
import { uiDir } from "../agent-ui/paths";
import { brokerErr } from "../dev-broker/broker.types";
import { type BrokerServer, serveBroker } from "../dev-broker/ipc";
import { writeDevSession } from "../dev-session";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createUiCommand } from "./ui";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const NOW = 1_700_000_000_000;
const cleanup: (() => unknown)[] = [];
let ctx: TestContext | undefined;
afterEach(async () => {
	ctx?.cleanup();
	for (const fn of cleanup.splice(0)) await fn();
});

const LINES: ConsoleLine[] = [
	{ ts: NOW - 5000, level: "log", kind: "console", text: "boot" },
	{ ts: NOW - 3000, level: "error", kind: "console", text: "bad thing" },
	{ ts: NOW - 1000, level: "error", kind: "exception", text: "Uncaught TypeError" },
];

const entry = (id: number, url: string, status: number): NetworkEntry => ({
	id,
	ts: NOW - 1000,
	method: "GET",
	url,
	status,
	durationMs: 12,
	requestHeaders: {},
	responseHeaders: {},
});
const ENTRIES = [entry(1, "https://a.test/x", 200), entry(2, "https://a.test/y", 404)];

const statusData = {
	state: { phase: "attached", targetId: "t", deviceName: "sim" },
	pid: 1,
	metroUrl: "http://localhost:8081",
	logDir: "/logs",
	startedAt: 0,
	console: { buffered: 3, total: 3 },
	network: { buffered: 2, total: 2 },
	methods: ["status", "eval"],
};

const matchesLine = (line: ConsoleLine, p: { grep?: string; level?: string; kind?: string; since?: number }) =>
	(p.grep === undefined || line.text.includes(p.grep)) &&
	(p.level === undefined || line.level === p.level) &&
	(p.kind === undefined || line.kind === p.kind) &&
	(p.since === undefined || line.ts >= p.since);

type LineParams = { grep?: string; level?: string; kind?: string; since?: number; limit?: number };
type Answer = (params: unknown) => { success: true; data: unknown };
const reply = (data: unknown): { success: true; data: unknown } => ({ success: true, data });
const attached = { phase: "attached", targetId: "t", deviceName: "sim" };

const ANSWERS: Record<string, Answer> = {
	status: () => reply(statusData),
	"console.query": (params) => {
		const p = (params ?? {}) as LineParams;
		const lines = LINES.filter((l) => matchesLine(l, p)).slice(-(p.limit ?? 200));
		return reply({ lines, total: lines.length });
	},
	"exceptions.query": () => {
		const lines = LINES.filter((l) => l.kind === "exception");
		return reply({ lines, total: lines.length });
	},
	"network.query": () => reply({ entries: ENTRIES, total: ENTRIES.length }),
	eval: () => reply({ value: 2 }),
	route: () => reply({ route: "(tabs)/home" }),
	reload: () => reply({ method: "expo" }),
	resume: () => reply({ state: attached }),
};

type Harness = {
	c: TestContext;
	calls: { method: string; params: unknown }[];
	run: (...argv: string[]) => Promise<number>;
	json: () => Record<string, unknown>;
	home: string;
};

/** A leased device; with `broker`, a live dev session whose broker stub answers. */
async function harness(options: { broker: boolean }): Promise<Harness> {
	const calls: { method: string; params: unknown }[] = [];
	const c = testContext([], { now: () => NOW });
	ctx = c;
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		c.now()
	);
	const home = c.env.WARDEN_HOME ?? "";
	if (options.broker) {
		const dir = mkdtempSync(join(tmpdir(), "wbh-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const served = await serveBroker(join(dir, "b.sock"), async (method, params) => {
			if (method !== "status") calls.push({ method, params });
			const answer = ANSWERS[method];
			return answer === undefined ? brokerErr("unknown_method", method) : answer(params);
		});
		if (!served.success) throw new Error(served.error.message);
		const server: BrokerServer = served.data;
		cleanup.push(() => server.close());
		writeDevSession(c.env, {
			version: 1,
			leaseId: "lease-1",
			pid: process.pid,
			platform: "ios",
			deviceId: UDID,
			port: 8081,
			metroUrl: "http://localhost:8081",
			logDir: join(home, "dev", "lease-1"),
			projectRoot: "/p",
			startedAt: "2026-10-27T00:00:00.000Z",
			brokerSocket: server.socketPath,
		});
	}
	const deps: UiDeps = { driver: async () => ok(null as never), sleep: async () => undefined };
	const command = createUiCommand(deps);
	return {
		c,
		calls,
		home,
		run: (...argv) => {
			c.argv = [...argv, "--udid", UDID];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
		json: () => JSON.parse(c.stdout[0] ?? "") as Record<string, unknown>,
	};
}

/** The collector's files as `ui logs start` leaves them. */
function writeCollected(h: Harness): void {
	const dir = uiDir(h.c, UDID);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "console.jsonl"), `${LINES.map((l) => JSON.stringify(l)).join("\n")}\n`);
	writeFileSync(join(dir, "network.jsonl"), `${ENTRIES.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

const keys = (doc: Record<string, unknown>) => Object.keys(doc.result as object).sort();

describe("warden ui with a live dev session", () => {
	test("logs reads console.query; text and result keys equal the collector-file path", async () => {
		const withBroker = await harness({ broker: true });
		expect(await withBroker.run("logs", "--level", "error", "--json")).toBe(0);
		const viaBroker = withBroker.json();
		expect(withBroker.calls).toEqual([{ method: "console.query", params: { level: "error", limit: 50 } }]);
		await withBroker.c.cleanup();
		const direct = await harness({ broker: false });
		writeCollected(direct);
		expect(await direct.run("logs", "--level", "error", "--json")).toBe(0);
		const viaFile = direct.json();
		expect(keys(viaBroker)).toEqual(keys(viaFile));
		expect((viaBroker.result as { lines: unknown }).lines).toEqual((viaFile.result as { lines: unknown }).lines);
		expect((viaBroker.result as { total: number }).total).toBe((viaFile.result as { total: number }).total);
	});

	test("--since and --grep reach the broker; the file path filters the same way", async () => {
		const h = await harness({ broker: true });
		await h.run("logs", "5", "--since", "2s", "--grep", "Uncaught");
		expect(h.calls[0]?.params).toEqual({ since: NOW - 2000, grep: "Uncaught", limit: 5 });
		await h.c.cleanup();
		const direct = await harness({ broker: false });
		writeCollected(direct);
		await direct.run("logs", "5", "--since", "2s", "--grep", "Uncaught");
		expect(direct.c.stdout[0]).toContain("Uncaught TypeError");
		expect(direct.c.stdout[0]).not.toContain("boot");
	});

	test("a bad --level is a usage error", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("logs", "--level", "loud")).toBe(1);
		expect(h.c.stderr.join("\n")).toContain("--level");
	});

	test("logs start spawns nothing and says the broker captures", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("logs", "start", "--json")).toBe(0);
		const result = h.json().result as { via: string; state: string };
		expect(result.via).toBe("broker");
		expect(result.state).toBe("collecting");
		expect(h.calls).toEqual([]);
	});

	test("network uses network.query and --id finds the entry", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("network", "--status", "4xx", "--json")).toBe(0);
		expect(h.calls[0]?.params).toEqual({ limit: 50, status: "4xx" });
		expect(keys(h.json())).toEqual(["entries", "file", "total"]);
		expect(await h.run("network", "--id", "2")).toBe(0);
		expect(h.c.stdout[0]).toContain("#2 GET https://a.test/y 404");
		expect(await h.run("network", "--id", "9")).toBe(1);
	});

	test("network file path honours --status and --grep", async () => {
		const h = await harness({ broker: false });
		writeCollected(h);
		expect(await h.run("network", "--status", "4xx", "--grep", "/y")).toBe(0);
		expect(h.c.stdout[0]).toBe("#2 GET https://a.test/y 404 12ms");
	});

	test("exceptions: broker, and the file fallback", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("exceptions")).toBe(0);
		expect(h.c.stdout[0]).toContain("!! Uncaught TypeError");
		await h.c.cleanup();
		const direct = await harness({ broker: false });
		writeCollected(direct);
		expect(await direct.run("exceptions")).toBe(0);
		expect(direct.c.stdout[0]).toContain("!! Uncaught TypeError");
		expect(direct.c.stdout[0]).not.toContain("bad thing");
	});

	test("eval, route, reload", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("eval", "1 + 1")).toBe(0);
		expect(h.c.stdout).toEqual(["2"]);
		expect(await h.run("route")).toBe(0);
		expect(h.c.stdout).toEqual(["(tabs)/home"]);
		expect(await h.run("reload", "--json")).toBe(0);
		expect(h.json().result).toEqual({ action: "reload", method: "expo" });
	});

	test("devtools status and resume", async () => {
		const h = await harness({ broker: true });
		expect(await h.run("devtools", "status")).toBe(0);
		expect(h.c.stdout[0]).toContain("broker attached (sim)");
		expect(await h.run("devtools", "resume")).toBe(0);
		expect(h.c.stdout[0]).toBe("broker attached");
	});

	test("devtools status without a dev session is devtools_unavailable with the hint", async () => {
		const h = await harness({ broker: false });
		expect(await h.run("devtools", "status", "--json")).toBe(3);
		const error = h.json().error as { code: string; hint: string };
		expect(error.code).toBe("devtools_unavailable");
		expect(error.hint).toBe("start `warden dev`");
	});
});
