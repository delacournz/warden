import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleLine } from "@delacour/warden-devtools/devtools.types";
import { resultFactory } from "@delacour/warden-types/result";
import type { BrokerPort } from "./broker-port";
import { devtoolsOps } from "./devtools";
import { uiPaths } from "./paths";
import { refStores } from "./ref-store";
import type { OpSession } from "./session";
import { stateStores } from "./state-store";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function session(broker?: BrokerPort): OpSession {
	const home = mkdtempSync(join(tmpdir(), "ops-devtools-"));
	homes.push(home);
	return {
		device: { id: "UDID", platform: "ios" },
		host: {
			env: {},
			cwd: home,
			home,
			now: () => 5_000,
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			sleep: async () => undefined,
		},
		driver: async () => ({ success: false, error: { code: "engine_unavailable", message: "no driver" } }),
		refs: refStores.createMemoryRefStore(),
		state: stateStores.createMemoryStateStore(),
		timeoutMs: 100,
		...(broker === undefined ? {} : { devtools: { broker } as unknown as NonNullable<OpSession["devtools"]> }),
	};
}

function seedConsole(s: OpSession, lines: ConsoleLine[]): void {
	const dir = uiPaths.uiDir(s.host.home, "UDID");
	mkdirSync(dir, { recursive: true });
	for (const line of lines) appendFileSync(join(dir, "console.jsonl"), `${JSON.stringify(line)}\n`);
}

const stubBroker = (over: Partial<BrokerPort>): BrokerPort => {
	const none = async () => undefined;
	return {
		available: async () => true,
		logDir: async () => "/logs",
		eval: none,
		tree: none,
		reload: none,
		console: none,
		exceptions: none,
		network: none,
		networkEntry: none,
		route: none,
		status: async () => ({ success: false, error: { code: "devtools_unavailable", message: "x", dispatched: "no" } }),
		resume: async () => ({ success: false, error: { code: "devtools_unavailable", message: "x", dispatched: "no" } }),
		...over,
	} as BrokerPort;
};

describe("logs op", () => {
	test("mark appends a note, tail reads it, clear empties the file", async () => {
		const s = session();
		const marked = await devtoolsOps.logs(s, { action: "mark", label: "  step one " });
		expect(marked.success && marked.data.text).toBe('marked "step one"');
		const tail = await devtoolsOps.logs(s, { action: "tail" });
		expect(tail.success && tail.data.result).toMatchObject({ total: 1 });
		const cleared = await devtoolsOps.logs(s, { action: "clear" });
		expect(cleared.success).toBe(true);
		const file = join(uiPaths.uiDir(s.host.home, "UDID"), "console.jsonl");
		expect(existsSync(file) && readFileSync(file, "utf8")).toBe("");
	});

	test("an empty label and a missing log are usage errors; stop without a collector too", async () => {
		const s = session();
		const empty = await devtoolsOps.logs(s, { action: "mark", label: " " });
		expect(!empty.success && empty.error.code).toBe("usage");
		const none = await devtoolsOps.logs(s, { action: "tail" });
		expect(!none.success && none.error.message).toBe("no console log yet");
		const stop = await devtoolsOps.logs(s, { action: "stop" });
		expect(!stop.success && stop.error.message).toBe("not collecting");
	});
});

describe("network op", () => {
	test("no network log yet is a usage error", async () => {
		const none = await devtoolsOps.network(session(), {});
		expect(!none.success && none.error.code).toBe("usage");
	});
});

describe("log filters", () => {
	const lines: ConsoleLine[] = [
		{ ts: 1_000, level: "log", kind: "console", text: "boot" },
		{ ts: 4_000, level: "warn", kind: "console", text: "Slow thing" },
		{ ts: 4_500, level: "error", kind: "exception", text: "boom" },
	];

	test("level, grep and since narrow the tail; total counts matches", async () => {
		const s = session();
		seedConsole(s, lines);
		const warn = await devtoolsOps.logs(s, { action: "tail", level: "warn" });
		expect(warn.success && warn.data.result).toMatchObject({ total: 2 });
		const grep = await devtoolsOps.logs(s, { action: "tail", grep: "slow" });
		expect(grep.success && grep.data.result).toMatchObject({ total: 1 });
		const since = await devtoolsOps.logs(s, { action: "tail", since: "2s" });
		expect(since.success && since.data.result).toMatchObject({ total: 2 });
		const bad = await devtoolsOps.logs(s, { action: "tail", level: "loud" });
		expect(!bad.success && bad.error.code).toBe("usage");
	});

	test("exceptions keeps only exception lines when no classifier is wired", async () => {
		const s = session();
		seedConsole(s, lines);
		const found = await devtoolsOps.exceptions(s, {});
		expect(found.success && found.data.result.lines.map((l) => l.text)).toEqual(["boom"]);
	});

	test("parseSince takes durations and ISO times, rejects the rest", () => {
		expect(devtoolsOps.parseSince("5s", 10_000)).toEqual(resultFactory.ok(5_000));
		expect(devtoolsOps.parseSince("1970-01-01T00:00:02.000Z", 0)).toEqual(resultFactory.ok(2_000));
		const bad = devtoolsOps.parseSince("soon", 0);
		expect(!bad.success && bad.error.code).toBe("usage");
	});
});

describe("broker-first devtools", () => {
	test("eval goes through the broker unless a Metro is named", async () => {
		const calls: string[] = [];
		const s = session(
			stubBroker({
				eval: async ({ expression }) => {
					calls.push(expression);
					return resultFactory.ok({ value: 42 });
				},
			})
		);
		const done = await devtoolsOps.evaluate(s, { expression: "1+41" });
		expect(done.success && done.data.result).toEqual({ value: 42 });
		expect(calls).toEqual(["1+41"]);
	});

	test("logs read the broker's answer and `logs start` spawns nothing when a broker captures", async () => {
		const s = session(
			stubBroker({
				console: async (q) =>
					resultFactory.ok({
						file: "/logs/console.jsonl",
						total: 3,
						lines: [{ ts: 1, level: "log", kind: "console", text: `limit ${q.limit}` }],
					}),
			})
		);
		const tail = await devtoolsOps.logs(s, { action: "tail", limit: 7 });
		expect(tail.success && tail.data.text).toContain("limit 7");
		const start = await devtoolsOps.logs(s, { action: "start" });
		expect(start.success && start.data.result).toMatchObject({ via: "broker", logDir: "/logs" });
	});

	test("a vanished broker (undefined) falls back to the collector file", async () => {
		const s = session(stubBroker({}));
		seedConsole(s, [{ ts: 1, level: "log", kind: "console", text: "from file" }]);
		const tail = await devtoolsOps.logs(s, { action: "tail" });
		expect(tail.success && tail.data.text).toContain("from file");
	});

	test("status and resume need a broker", async () => {
		const status = await devtoolsOps.devtoolsStatus(session());
		expect(!status.success && status.error.code).toBe("devtools_unavailable");
		const resume = await devtoolsOps.devtoolsResume(session());
		expect(!resume.success && resume.error.code).toBe("devtools_unavailable");
	});
});
