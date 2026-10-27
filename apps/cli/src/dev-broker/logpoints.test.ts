import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FakeCdpRequest,
	type FakeConnection,
	type FakeMetro,
	fakePage,
	fakeTarget,
	startFakeMetro,
} from "@delacour/warden-e2e/devtools/devtools.testing";
import { type Broker, callBroker, startBroker } from "./broker";
import {
	createLogpointsExtension,
	type LogpointInfo,
	logpointCondition,
	logpointIdOf,
	parseLocation,
} from "./logpoints";
import { METRO_BUNDLE_URL, METRO_MAP } from "./source-map.testing";

const dirs: string[] = [];
const brokers: Broker[] = [];
const metros: FakeMetro[] = [];

afterEach(async () => {
	for (const broker of brokers.splice(0)) await broker.close();
	for (const metro of metros.splice(0)) await metro.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Rig = { broker: Broker; metro: FakeMetro; fetched: string[]; teardown: () => void };

/** A broker on a fake Metro whose Hermes replays one bundle script on every `Debugger.enable`. */
async function rig(options: { legacy?: boolean } = {}): Promise<Rig> {
	const net = fakePage();
	let scripts = 0;
	let breakpoints = 0;
	const respond = (request: FakeCdpRequest, connection: FakeConnection) => {
		if (request.method === "Debugger.enable") {
			connection.emit("Debugger.scriptParsed", { scriptId: "native", url: "InternalBytecode.js" });
			connection.emit("Debugger.scriptParsed", { scriptId: `s${++scripts}`, url: METRO_BUNDLE_URL, sourceMapURL: "" });
			return { result: {} };
		}
		if (request.method === "Debugger.setBreakpointByUrl") {
			return { result: { breakpointId: `bp${++breakpoints}`, locations: [] } };
		}
		return net.respond(request, connection);
	};
	const metro = startFakeMetro({ respond });
	metros.push(metro);
	if (options.legacy) metro.setTargets([fakeTarget(metro.port - 1, 1, { reactNative: { logicalDeviceId: "dev1" } })]);
	const logDir = mkdtempSync(join(tmpdir(), "wlp-"));
	dirs.push(logDir);
	const started = await startBroker({
		metroUrl: metro.url,
		device: { deviceName: "iPhone A" },
		logDir,
		retry: { initialMs: 10, maxMs: 20 },
		networkPollMs: 10,
	});
	if (!started.success) throw new Error(started.error.message);
	const broker = started.data;
	brokers.push(broker);
	const fetched: string[] = [];
	const teardown = createLogpointsExtension({
		fetch: async (url) => {
			fetched.push(url);
			return { ok: true, status: 200, text: async () => JSON.stringify(METRO_MAP) };
		},
	})(broker, { metroUrl: metro.url, logDir, log: () => undefined });
	await until(() => broker.state().phase === "attached", "attached");
	return { broker, metro, fetched, teardown };
}

const call = (r: Rig, method: string, params: unknown = {}) => callBroker(r.broker.socketPath, { method, params });

/** `logpoint.list`, typed. */
const logpointsOf = async (r: Rig): Promise<LogpointInfo[]> => {
	const listed = await call(r, "logpoint.list");
	if (!listed.success) throw new Error(listed.error.message);
	return (listed.data as { logpoints: LogpointInfo[] }).logpoints;
};

const sent = (r: Rig, method: string) => r.metro.requests.filter((request) => request.method === method);

const hit = (id: string, value: string) => ({
	type: "log",
	args: [
		{ type: "string", value: `[logpoint:${id}]` },
		{ type: "string", value },
	],
	timestamp: 1,
});

describe("logpoint.add", () => {
	test("maps the original line through the source map and sets a never-pausing conditional breakpoint", async () => {
		const r = await rig();
		expect(sent(r, "Debugger.enable")).toHaveLength(0);
		const added = await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n + 1", id: "t1" });
		expect(added).toEqual({
			success: true,
			data: {
				logpoint: {
					id: "t1",
					location: "src/greet.ts:2",
					expression: "n + 1",
					hitCount: 0,
					armed: true,
					resolved: { source: "/Users/dev/app/src/greet.ts", line: 2, col: 9 },
				},
			},
		});
		expect(sent(r, "Debugger.enable")).toHaveLength(1);
		expect(r.fetched).toEqual([`${r.metro.url}/index.map?platform=ios&dev=true`]);
		const [set, ...rest] = sent(r, "Debugger.setBreakpointByUrl");
		expect(rest).toHaveLength(0);
		expect(set?.params).toMatchObject({ url: METRO_BUNDLE_URL, lineNumber: 1, columnNumber: 2 });
		expect(String(set?.params.condition)).toBe(logpointCondition("t1", "n + 1"));
		expect(String(set?.params.condition)).toContain("return false");
	});

	test("a column picks the mapping at or after it; an id is generated when none is given", async () => {
		const r = await rig();
		const added = await call(r, "logpoint.add", { location: "src/greet.ts:2:10", expression: "n" });
		expect(added.success && added.data).toMatchObject({ logpoint: { id: "lp1", resolved: { col: 15 } } });
		expect(sent(r, "Debugger.setBreakpointByUrl")[0]?.params).toMatchObject({ lineNumber: 1, columnNumber: 8 });
	});

	test("an ambiguous file is refused with the candidates and nothing is left behind", async () => {
		const r = await rig();
		const added = await call(r, "logpoint.add", { location: "src/App.tsx:1", expression: "1" });
		expect(added.success).toBe(false);
		if (added.success) return;
		expect(added.error.message).toContain("/Users/dev/app/src/App.tsx");
		expect(added.error.message).toContain("/Users/dev/app/packages/ui/src/App.tsx");
		expect(sent(r, "Debugger.setBreakpointByUrl")).toHaveLength(0);
		await until(() => sent(r, "Debugger.disable").length === 1, "Debugger.disable");
		expect(await logpointsOf(r)).toEqual([]);
	});

	test("an unknown file, a bad location and a duplicate id are bad requests", async () => {
		const r = await rig();
		const unknown = await call(r, "logpoint.add", { location: "src/nope.ts:3", expression: "1" });
		expect(!unknown.success && unknown.error.code).toBe("bad_request");
		const bad = await call(r, "logpoint.add", { location: "greet.ts", expression: "1" });
		expect(!bad.success && bad.error.message).toContain("<file>:<line>");
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "1", id: "dup" });
		const dup = await call(r, "logpoint.add", { location: "src/greet.ts:3", expression: "1", id: "dup" });
		expect(!dup.success && dup.error.message).toContain("dup exists");
	});

	test("legacy Hermes targets answer logpoints_unsupported and never enable Debugger", async () => {
		const r = await rig({ legacy: true });
		const added = await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "1" });
		expect(!added.success && added.error.code).toBe("logpoints_unsupported");
		expect(sent(r, "Debugger.enable")).toHaveLength(0);
	});
});

describe("re-arming", () => {
	test("sets the breakpoint again after the socket reconnects (a new Debugger session)", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n", id: "t1" });
		r.metro.dropAll();
		await until(() => sent(r, "Debugger.setBreakpointByUrl").length === 2, "breakpoint set again");
		expect(sent(r, "Debugger.enable")).toHaveLength(2);
		expect((await logpointsOf(r)).map((lp) => lp.armed)).toEqual([true]);
	});

	test("a new script of the bundle replaces the old breakpoint", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n", id: "t1" });
		r.metro.emit("Debugger.scriptParsed", { scriptId: "reloaded", url: METRO_BUNDLE_URL });
		await until(() => sent(r, "Debugger.setBreakpointByUrl").length === 2, "second breakpoint");
		expect(sent(r, "Debugger.removeBreakpoint").map((request) => request.params)).toEqual([{ breakpointId: "bp1" }]);
		expect(r.fetched).toHaveLength(2);
	});

	test("a bundle that appears after the logpoint arms it then", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n", id: "t1" });
		r.metro.emit("Debugger.scriptParsed", { scriptId: "other", url: "http://localhost:8081/second.bundle?x=1" });
		await until(() => sent(r, "Debugger.setBreakpointByUrl").length === 2, "armed in the second bundle");
		expect(sent(r, "Debugger.setBreakpointByUrl")[1]?.params.url).toBe("http://localhost:8081/second.bundle?x=1");
	});
});

describe("hits", () => {
	test("--hits removes the logpoint after N hits and disables Debugger with the last one", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n", id: "h", hits: 2 });
		expect(String(sent(r, "Debugger.setBreakpointByUrl")[0]?.params.condition)).toContain("__wardenLogpoints");
		r.metro.emit("Runtime.consoleAPICalled", hit("h", "1"));
		let counted = 0;
		for (let i = 0; i < 100 && counted < 1; i++) {
			counted = (await logpointsOf(r))[0]?.hitCount ?? 0;
			if (counted < 1) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(counted).toBe(1);
		r.metro.emit("Runtime.consoleAPICalled", hit("h", "2"));
		await until(() => sent(r, "Debugger.disable").length === 1, "auto-removed");
		expect(sent(r, "Debugger.removeBreakpoint").map((request) => request.params)).toEqual([{ breakpointId: "bp1" }]);
		expect(await logpointsOf(r)).toEqual([]);
	});

	test("a retried arm only allows the hits still outstanding", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "n", id: "h", hits: 3 });
		r.metro.emit("Runtime.consoleAPICalled", hit("h", "1"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		r.metro.dropAll();
		await until(() => sent(r, "Debugger.setBreakpointByUrl").length === 2, "re-armed");
		expect(String(sent(r, "Debugger.setBreakpointByUrl")[1]?.params.condition)).toBe(logpointCondition("h", "n", 2));
	});
});

describe("remove, clear, teardown", () => {
	test("remove drops one, clear the rest, an unknown id is a bad request", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "1", id: "a" });
		await call(r, "logpoint.add", { location: "src/greet.ts:3", expression: "2", id: "b" });
		expect(await call(r, "logpoint.remove", { id: "a" })).toEqual({ success: true, data: { removed: "a" } });
		expect(sent(r, "Debugger.disable")).toHaveLength(0);
		const missing = await call(r, "logpoint.remove", { id: "zz" });
		expect(!missing.success && missing.error.hint).toContain("b");
		expect(await call(r, "logpoint.clear")).toEqual({ success: true, data: { removed: ["b"] } });
		expect(sent(r, "Debugger.disable")).toHaveLength(1);
	});

	test("teardown unregisters the methods and disables Debugger", async () => {
		const r = await rig();
		await call(r, "logpoint.add", { location: "src/greet.ts:2", expression: "1" });
		r.teardown();
		await until(() => sent(r, "Debugger.disable").length === 1, "Debugger.disable");
		const after = await call(r, "logpoint.list");
		expect(!after.success && after.error.code).toBe("unknown_method");
	});
});

describe("logpointCondition", () => {
	/** Runs the condition the way the engine would, with `console.log` captured. */
	function run(condition: string, scope: Record<string, unknown> = {}) {
		const logged: unknown[][] = [];
		const g = globalThis as unknown as { console: { log: (...args: unknown[]) => void }; __wardenLogpoints?: unknown };
		const original = g.console.log;
		g.console.log = (...args) => void logged.push(args);
		try {
			const names = Object.keys(scope);
			const value = new Function(...names, `return ${condition}`)(...names.map((name) => scope[name]));
			return { value, logged };
		} finally {
			g.console.log = original;
			delete g.__wardenLogpoints;
		}
	}

	test("logs the tagged value and returns false", () => {
		expect(run(logpointCondition("a", "n * 2"), { n: 21 })).toEqual({ value: false, logged: [["[logpoint:a]", 42]] });
	});

	test("an exception is logged, not thrown", () => {
		const { value, logged } = run(logpointCondition("a", "missing.x"));
		expect(value).toBe(false);
		expect(logged[0]?.[0]).toBe("[logpoint:a] error");
	});

	test("a trailing line comment in the expression cannot swallow the closing", () => {
		expect(run(logpointCondition("a", "1 // why")).logged).toEqual([["[logpoint:a]", 1]]);
	});

	test("with hits the page stops logging after that many", () => {
		const condition = logpointCondition("a", "1", 2);
		const g = globalThis as unknown as { __wardenLogpoints?: unknown };
		const logged: unknown[][] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => void logged.push(args);
		try {
			for (let i = 0; i < 5; i++) new Function(`return ${condition}`)();
		} finally {
			console.log = original;
			delete g.__wardenLogpoints;
		}
		expect(logged).toHaveLength(2);
	});
});

describe("helpers", () => {
	test("parseLocation", () => {
		expect(parseLocation("src/a.tsx:42")).toEqual({ file: "src/a.tsx", line: 42 });
		expect(parseLocation("src/a.tsx:42:7")).toEqual({ file: "src/a.tsx", line: 42, col: 7 });
		expect(parseLocation("src/a.tsx")).toBeUndefined();
		expect(parseLocation("src/a.tsx:0")).toBeUndefined();
	});

	test("logpointIdOf", () => {
		expect(logpointIdOf("[logpoint:ab-1] 3 4")).toBe("ab-1");
		expect(logpointIdOf("[logpoint:ab-1] error ReferenceError")).toBe("ab-1");
		expect(logpointIdOf("hello [logpoint:x]")).toBeUndefined();
	});
});
