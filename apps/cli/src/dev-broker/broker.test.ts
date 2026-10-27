import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FakeCdpRequest,
	type FakeConnection,
	type FakeMetro,
	type FakeReply,
	fakePage,
	fakeTarget,
	page,
	startFakeMetro,
} from "@delacour/warden-e2e/devtools/devtools.testing";
import { ROUTE_EXPRESSION } from "@delacour/warden-e2e/devtools/route.script";
import { type Broker, type BrokerOptions, callBroker, NEW_DEBUGGER_TAG, startBroker } from "./broker";
import { brokerErr } from "./broker.types";

const dirs: string[] = [];
const brokers: Broker[] = [];
const metros: FakeMetro[] = [];

afterEach(async () => {
	for (const broker of brokers.splice(0)) await broker.close();
	for (const metro of metros.splice(0)) await metro.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const consoleEvent = (text: string, ts: number, type = "log") => ({
	type,
	args: [{ type: "string", value: text }],
	timestamp: ts,
});

const exceptionEvent = (description: string, ts: number) => ({
	timestamp: ts,
	exceptionDetails: { text: "Uncaught", exception: { type: "object", subtype: "error", description } },
});

const TREE = {
	components: [
		{ id: 0, name: "App", parent: null, rect: { x: 0, y: 0, w: 390, h: 800 } },
		{ id: 1, name: "View", testID: "list", parent: 0, rect: { x: 0, y: 0, w: 390, h: 400 } },
		{ id: 2, name: "Row", parent: 1, rect: { x: 0, y: 0, w: 390, h: 40 } },
	],
	truncated: false,
};

const evalValue = (value: unknown): FakeReply => ({
	result: { result: { type: typeof value === "number" ? "number" : "string", value } },
});

/** An app behind the fake Metro: network page, route, tree (polled), eval, and a reload that clears the JS context. */
function fakeApp() {
	const net = fakePage();
	const respond = (request: FakeCdpRequest, connection: FakeConnection): FakeReply | undefined => {
		if (request.method !== "Runtime.evaluate") return undefined;
		const expression = String(request.params.expression);
		if (expression === "typeof __warden_cb") return evalValue("undefined");
		if (expression === ROUTE_EXPRESSION) return evalValue(JSON.stringify({ route: ["__root", "(tabs)", "todos"] }));
		if (expression.includes("__warden_tree_results") && expression.includes("delete s[")) {
			return evalValue(JSON.stringify(TREE));
		}
		if (expression.includes("reloadAppAsync")) {
			setTimeout(() => connection.emit("Runtime.executionContextsCleared"), 10);
			return evalValue("expo");
		}
		if (expression === "1 + 1") return evalValue(2);
		if (expression === "boom()") {
			return {
				result: {
					result: { type: "object", subtype: "error" },
					exceptionDetails: {
						text: "Uncaught",
						exception: { type: "object", subtype: "error", description: "ReferenceError: boom" },
					},
				},
			};
		}
		return net.respond(request, connection);
	};
	return { net, respond };
}

type Started = {
	broker: Broker;
	metro: FakeMetro;
	logDir: string;
	app: ReturnType<typeof fakeApp>;
	phases: string[];
	logs: string[];
};

async function start(
	overrides: Partial<BrokerOptions> = {},
	metroOptions: Parameters<typeof startFakeMetro>[0] = {}
): Promise<Started> {
	const app = fakeApp();
	const metro = startFakeMetro({ respond: app.respond, ...metroOptions });
	metros.push(metro);
	const logDir = mkdtempSync(join(tmpdir(), "wbk-"));
	dirs.push(logDir);
	const phases: string[] = [];
	const logs: string[] = [];
	const started = await startBroker({
		metroUrl: metro.url,
		device: { deviceName: "iPhone A" },
		logDir,
		retry: { initialMs: 10, maxMs: 20 },
		networkPollMs: 10,
		onState: (state) => phases.push(state.phase),
		log: (line) => logs.push(line),
		...overrides,
	});
	if (!started.success) throw new Error(started.error.message);
	brokers.push(started.data);
	return { broker: started.data, metro, logDir, app, phases, logs };
}

/** attached with exactly one live inspector socket */
const attached = (s: Started) =>
	until(() => s.broker.state().phase === "attached" && s.metro.connections.length === 1, "attached");

const status = async (s: Started) => {
	const result = await callBroker(s.broker.socketPath, { method: "status", params: {} });
	if (!result.success) throw new Error(result.error.message);
	return result.data;
};

const consoleTexts = async (s: Started, params: object = {}) => {
	const result = await callBroker(s.broker.socketPath, { method: "console.query", params });
	if (!result.success) throw new Error(result.error.message);
	return result.data.lines.map((line) => line.text);
};

const kick = (metro: FakeMetro) =>
	metro.connections[0]?.close(1000, `${NEW_DEBUGGER_TAG} New debugger opened for the same app instance`);

describe("capture and queries", () => {
	test("attaches once and answers console queries with filters", async () => {
		const s = await start();
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("alpha", 1000));
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("Beta warn", 2000, "warning"));
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("gamma", 3000, "error"));
		await until(async () => (await status(s)).console.total === 3, "3 lines");

		expect(await consoleTexts(s)).toEqual(["alpha", "Beta warn", "gamma"]);
		expect(await consoleTexts(s, { level: "warn" })).toEqual(["Beta warn", "gamma"]);
		expect(await consoleTexts(s, { grep: "BETA" })).toEqual(["Beta warn"]);
		expect(await consoleTexts(s, { since: 2000, limit: 1 })).toEqual(["gamma"]);
		expect(await consoleTexts(s, { kind: "exception" })).toEqual([]);
		const limited = await callBroker(s.broker.socketPath, {
			method: "console.query",
			params: { since: 2000, limit: 1 },
		});
		expect(limited.success && limited.data.total).toBe(2);
		expect(s.metro.connections).toHaveLength(1);
	});

	test("exceptions.query returns only exceptions", async () => {
		const s = await start();
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("noise", 1000));
		s.metro.emit("Runtime.exceptionThrown", exceptionEvent("Error: kaboom", 2000));
		await until(async () => (await status(s)).console.total === 2, "2 lines");
		const result = await callBroker(s.broker.socketPath, { method: "exceptions.query", params: {} });
		expect(result.success && result.data.lines.map((l) => [l.kind, l.text])).toEqual([["exception", "Error: kaboom"]]);
	});

	test("exceptions.query includes errors React Native reports through ExceptionsManager, not plain console.error", async () => {
		const s = await start();
		await attached(s);
		const frame = (functionName: string) => ({
			functionName,
			url: "http://localhost:8081/index.bundle//&platform=ios",
			lineNumber: 10,
			columnNumber: 2,
		});
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("just an error log", 1000, "error"));
		s.metro.emit("Runtime.consoleAPICalled", {
			...consoleEvent("Error: boom\n    at thrower (:1:58)", 2000, "error"),
			stackTrace: { callFrames: [frame("methodName"), frame("reactConsoleErrorHandler"), frame("reportException")] },
		});
		await until(async () => (await status(s)).console.total === 2, "2 lines");
		const result = await callBroker(s.broker.socketPath, { method: "exceptions.query", params: {} });
		expect(result.success && result.data.lines.map((l) => l.text)).toEqual(["Error: boom\n    at thrower (:1:58)"]);
	});

	test("writes console.jsonl and network.jsonl in the ui logs row shapes", async () => {
		const s = await start();
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("to disk", 1000));
		s.app.net.state.queue.push(page("https://api.test/todos", { ts: 5 }));
		await until(async () => (await status(s)).network.total === 1, "1 request");
		await until(() => readFileSync(join(s.logDir, "console.jsonl"), "utf8").includes("to disk"), "console.jsonl");
		const consoleRow = JSON.parse(readFileSync(join(s.logDir, "console.jsonl"), "utf8").trim());
		expect(consoleRow).toMatchObject({ ts: 1000, level: "log", kind: "console", text: "to disk" });
		await until(() => readFileSync(join(s.logDir, "network.jsonl"), "utf8").includes("api.test"), "network.jsonl");
		const networkRow = JSON.parse(readFileSync(join(s.logDir, "network.jsonl"), "utf8").trim());
		expect(networkRow).toMatchObject({ id: 1, method: "GET", url: "https://api.test/todos", status: 200 });
	});

	test("network.query filters by url, status code and class, with broker ids", async () => {
		const s = await start();
		await attached(s);
		s.app.net.state.queue.push(
			page("https://api.test/todos", { ts: 10 }),
			page("https://api.test/login", { ts: 20, status: 401 }),
			page("https://cdn.test/img.png", { ts: 30, status: 503 })
		);
		const query = async (params: object) => {
			const result = await callBroker(s.broker.socketPath, { method: "network.query", params });
			if (!result.success) throw new Error(result.error.message);
			return result.data.entries.map((e) => e.url);
		};
		await until(async () => (await query({})).length === 3, "3 entries");
		expect(await query({ urlGrep: "API.TEST" })).toEqual(["https://api.test/todos", "https://api.test/login"]);
		expect(await query({ status: 401 })).toEqual(["https://api.test/login"]);
		expect(await query({ status: "5xx" })).toEqual(["https://cdn.test/img.png"]);
		expect(await query({ since: 20, limit: 1 })).toEqual(["https://cdn.test/img.png"]);
		const ids = await callBroker(s.broker.socketPath, { method: "network.query", params: {} });
		expect(ids.success && ids.data.entries.map((e) => e.id)).toEqual([1, 2, 3]);
	});

	test("eval returns the value, or the page's error", async () => {
		const s = await start();
		await attached(s);
		const good = await callBroker(s.broker.socketPath, { method: "eval", params: { expression: "1 + 1" } });
		expect(good).toEqual({ success: true, data: { value: 2 } });
		const bad = await callBroker(s.broker.socketPath, { method: "eval", params: { expression: "boom()" } });
		expect(bad.success).toBe(false);
		if (!bad.success) {
			expect(bad.error.code).toBe("eval_failed");
			expect(bad.error.message).toContain("ReferenceError: boom");
		}
	});

	test("route answers the focused route key", async () => {
		const s = await start();
		await attached(s);
		expect(await callBroker(s.broker.socketPath, { method: "route", params: {} })).toEqual({
			success: true,
			data: { route: "(tabs)/todos" },
		});
	});

	test("tree answers lines, and depth / testID cut it", async () => {
		const s = await start();
		await attached(s);
		const full = await callBroker(s.broker.socketPath, { method: "tree", params: {} });
		expect(full.success && full.data.lines).toEqual([
			"App (0,0 390×800)",
			"  View testID=list (0,0 390×400)",
			"    Row (0,0 390×40)",
		]);
		const cut = await callBroker(s.broker.socketPath, { method: "tree", params: { testID: "list", depth: 0 } });
		expect(cut.success && cut.data.lines).toEqual(["View testID=list (0,0 390×400)"]);
	});

	test("reload runs through the session and resolves once the app is back", async () => {
		const s = await start();
		await attached(s);
		const result = await callBroker(s.broker.socketPath, { method: "reload", params: {} });
		expect(result).toEqual({ success: true, data: { method: "expo" } });
		await attached(s);
	});

	test("status lists state, counts and every method", async () => {
		const s = await start();
		await attached(s);
		const info = await status(s);
		expect(info.state.phase).toBe("attached");
		expect(info.pid).toBe(process.pid);
		expect(info.metroUrl).toBe(s.metro.url);
		expect(info.methods).toEqual(
			expect.arrayContaining([
				"status",
				"console.query",
				"exceptions.query",
				"network.query",
				"eval",
				"tree",
				"route",
				"reload",
				"resume",
			])
		);
	});

	test("rejects unknown methods and bad params", async () => {
		const s = await start();
		await attached(s);
		const unknown = await callBroker(s.broker.socketPath, { method: "nope", params: {} });
		expect(unknown.success).toBe(false);
		if (!unknown.success) expect(unknown.error.code).toBe("unknown_method");
		const bad = await callBroker(s.broker.socketPath, { method: "console.query", params: { limit: -1 } });
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error.code).toBe("bad_request");
	});
});

describe("attach lifecycle", () => {
	test("does not fail when Metro has no page yet, and attaches when one appears", async () => {
		const s = await start({}, { targets: [] });
		await until(() => s.broker.state().phase === "connecting" && s.logs.length > 0, "retrying");
		const early = await callBroker(s.broker.socketPath, { method: "eval", params: { expression: "1 + 1" } });
		expect(early.success).toBe(false);
		if (!early.success) expect(early.error.code).toBe("devtools_unavailable");
		s.metro.setTargets([fakeTarget(s.metro.port - 1, 1)]);
		await attached(s);
		const late = await callBroker(s.broker.socketPath, { method: "eval", params: { expression: "1 + 1" } });
		expect(late.success).toBe(true);
	});

	test("a plain socket drop reconnects and stays attached", async () => {
		const s = await start();
		await attached(s);
		s.metro.dropAll();
		await until(() => s.metro.connections.length === 1 && s.broker.state().phase === "attached", "reattached");
		expect(s.phases).not.toContain("yielded");
	});

	test("close ends the session, the socket and the state", async () => {
		const s = await start();
		await attached(s);
		const socketPath = s.broker.socketPath;
		await s.broker.close();
		expect(s.broker.state()).toEqual({ phase: "closed" });
		expect(existsSync(socketPath)).toBe(false);
		await until(() => s.metro.connections.length === 0, "socket closed");
		const after = await callBroker(socketPath, { method: "status", params: {} });
		expect(after.success).toBe(false);
	});

	test("uses a short temp socket when the log dir path is too long", async () => {
		const base = mkdtempSync(join(tmpdir(), "wbk-"));
		dirs.push(base);
		const s = await start({ logDir: join(base, "x".repeat(110)) });
		expect(s.broker.socketPath).toMatch(/warden-[0-9a-f]{12}\.sock$/);
		await attached(s);
		expect((await status(s)).state.phase).toBe("attached");
	});
});

describe("takeover", () => {
	test("another debugger kicks us: yielded, no reconnect, queries say devtools_unavailable", async () => {
		const s = await start();
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("before", 1000));
		await until(async () => (await status(s)).console.total === 1, "line");
		kick(s.metro);
		await until(() => s.broker.state().phase === "yielded", "yielded");
		expect(s.logs).toContain("devtools: yielded to another debugger");

		await pause(150);
		expect(s.metro.connections).toHaveLength(0);
		const evaluated = await callBroker(s.broker.socketPath, { method: "eval", params: { expression: "1 + 1" } });
		expect(evaluated.success).toBe(false);
		if (!evaluated.success) {
			expect(evaluated.error.code).toBe("devtools_unavailable");
			expect(evaluated.error.hint).toContain("resume");
		}
		expect(await consoleTexts(s)).toEqual(["before"]);
	});

	test("resume takes the page back and keeps the buffered lines", async () => {
		const s = await start();
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("before", 1000));
		await until(async () => (await status(s)).console.total === 1, "line");
		kick(s.metro);
		await until(() => s.broker.state().phase === "yielded", "yielded");

		const resumed = await callBroker(s.broker.socketPath, { method: "resume", params: {} });
		expect(resumed.success).toBe(true);
		await attached(s);
		s.metro.emit("Runtime.consoleAPICalled", consoleEvent("after", 2000));
		await until(async () => (await status(s)).console.total === 2, "second line");
		expect(await consoleTexts(s)).toEqual(["before", "after"]);
	});

	test("yieldRetry re-attaches on its own schedule", async () => {
		const s = await start({ yieldRetry: { initialMs: 60, maxMs: 120 } });
		await attached(s);
		kick(s.metro);
		await until(() => s.broker.state().phase === "yielded", "yielded");
		await attached(s);
		expect(s.phases).toEqual(expect.arrayContaining(["yielded", "connecting", "attached"]));
	});

	test("resume outside yielded does nothing", async () => {
		const s = await start();
		await attached(s);
		s.broker.resume();
		await pause(50);
		expect(s.metro.connections).toHaveLength(1);
		expect(s.broker.state().phase).toBe("attached");
	});
});

describe("extension points", () => {
	test("registerMethod serves a method with the broker context, rejects duplicates, and unregisters", async () => {
		const s = await start();
		await attached(s);
		const registered = s.broker.registerMethod("logpoint.list", async (params, context) => {
			const session = context.requireSession();
			if (!session.success) return session;
			return { success: true, data: { params, phase: context.state().phase } };
		});
		expect(registered.success).toBe(true);
		const called = await callBroker(s.broker.socketPath, { method: "logpoint.list", params: { a: 1 } });
		expect(called).toEqual({ success: true, data: { params: { a: 1 }, phase: "attached" } });
		expect(s.broker.registerMethod("logpoint.list", async () => brokerErr("bad_request", "x")).success).toBe(false);
		expect(s.broker.registerMethod("eval", async () => brokerErr("bad_request", "x")).success).toBe(false);
		expect((await status(s)).methods).toContain("logpoint.list");
		if (registered.success) registered.data();
		const gone = await callBroker(s.broker.socketPath, { method: "logpoint.list", params: {} });
		expect(gone.success).toBe(false);
	});

	test("a line processor rewrites what queries return, not what is stored", async () => {
		const s = await start();
		await attached(s);
		s.broker.addLineProcessor((line) =>
			line.kind === "exception" ? { ...line, text: `${line.text} [mapped]` } : line
		);
		s.metro.emit("Runtime.exceptionThrown", exceptionEvent("Error: kaboom", 1000));
		await until(async () => (await status(s)).console.total === 1, "line");
		const result = await callBroker(s.broker.socketPath, { method: "exceptions.query", params: {} });
		expect(result.success && result.data.lines.map((l) => l.text)).toEqual(["Error: kaboom [mapped]"]);
		await until(() => readFileSync(join(s.logDir, "console.jsonl"), "utf8").includes("kaboom"), "jsonl");
		expect(readFileSync(join(s.logDir, "console.jsonl"), "utf8")).not.toContain("[mapped]");
	});

	test("onAttach fires for the live session and for each re-attach", async () => {
		const s = await start();
		await attached(s);
		let calls = 0;
		s.broker.onAttach(() => {
			calls++;
		});
		expect(calls).toBe(1);
		kick(s.metro);
		await until(() => s.broker.state().phase === "yielded", "yielded");
		s.broker.resume();
		await until(() => calls === 2, "second attach");
	});
});
