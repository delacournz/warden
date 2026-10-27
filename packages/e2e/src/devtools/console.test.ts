import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachConsole, createConsoleCapture, formatConsoleArgs } from "./console";
import { startFakeMetro } from "./devtools.testing";
import type { CdpTapEvent, ConsoleLine } from "./devtools.types";
import { connectDevtools } from "./session";

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const str = (value: string) => ({ type: "string", value });
const num = (value: number) => ({ type: "number", value, description: String(value) });

function consoleEvent(
	type: string,
	args: unknown[],
	extra: { timestamp?: number; stackTrace?: unknown; replay?: boolean; connection?: number } = {}
): CdpTapEvent {
	return {
		method: "Runtime.consoleAPICalled",
		params: { type, args, timestamp: extra.timestamp ?? 1000, stackTrace: extra.stackTrace },
		connection: extra.connection ?? 1,
		replay: extra.replay ?? false,
	};
}

describe("formatConsoleArgs", () => {
	test("primitives: top-level strings raw, others by value", () => {
		expect(formatConsoleArgs([str("hello"), num(3), { type: "boolean", value: true }]).text).toBe("hello 3 true");
		expect(formatConsoleArgs([{ type: "undefined" }, { type: "object", subtype: "null", value: null }]).text).toBe(
			"undefined null"
		);
		expect(formatConsoleArgs([{ type: "number", unserializableValue: "NaN", description: "NaN" }]).text).toBe("NaN");
		expect(formatConsoleArgs([{ type: "bigint", unserializableValue: "10n", description: "10n" }]).text).toBe("10n");
	});

	test("objects use the shallow preview, nested strings are quoted", () => {
		const object = {
			type: "object",
			className: "Object",
			description: "Object",
			preview: {
				type: "object",
				overflow: false,
				properties: [
					{ name: "id", type: "number", value: "7" },
					{ name: "name", type: "string", value: "ann" },
					{ name: "tags", type: "object", subtype: "array", value: "Array(2)" },
				],
			},
		};
		expect(formatConsoleArgs([object]).text).toBe('{id: 7, name: "ann", tags: Array(2)}');
	});

	test("arrays, overflow, class instances", () => {
		const array = {
			type: "object",
			subtype: "array",
			description: "Array(5)",
			preview: {
				type: "object",
				subtype: "array",
				overflow: true,
				properties: [
					{ name: "0", type: "number", value: "1" },
					{ name: "1", type: "string", value: "b" },
				],
			},
		};
		expect(formatConsoleArgs([array]).text).toBe('[1, "b", …]');
		const instance = {
			type: "object",
			className: "Point",
			description: "Point",
			preview: { type: "object", overflow: false, properties: [{ name: "x", type: "number", value: "1" }] },
		};
		expect(formatConsoleArgs([instance]).text).toBe("Point {x: 1}");
	});

	test("objects without a preview fall back to description; errors keep their stack text", () => {
		expect(formatConsoleArgs([{ type: "object", className: "Object", description: "Object" }]).text).toBe("Object");
		const error = { type: "object", subtype: "error", description: "Error: boom\n    at f (app.js:1:1)" };
		expect(formatConsoleArgs([error]).text).toBe("Error: boom\n    at f (app.js:1:1)");
	});

	test("printf specifiers consume arguments; leftovers are appended", () => {
		expect(formatConsoleArgs([str("user %s has %d items (%%)"), str("ann"), num(3), str("extra")]).text).toBe(
			"user ann has 3 items (%) extra"
		);
		expect(formatConsoleArgs([str("%cstyled"), str("color: red")]).text).toBe("styled");
		expect(formatConsoleArgs([str("100%"), num(1)]).text).toBe("100% 1");
	});

	test("args are each rendered on their own", () => {
		expect(formatConsoleArgs([str("a %s"), str("b")]).args).toEqual(["a %s", "b"]);
	});
});

describe("console capture lines", () => {
	test("level, text, source (1-based) and args", () => {
		const capture = createConsoleCapture({ now: () => 5 });
		capture.handle(
			consoleEvent("log", [str("hi"), num(2)], {
				timestamp: 1234,
				stackTrace: {
					callFrames: [{ url: "http://x/index.bundle", lineNumber: 9, columnNumber: 4, functionName: "f" }],
				},
			})
		);
		expect(capture.lines()).toEqual([
			{
				ts: 1234,
				level: "log",
				kind: "console",
				text: "hi 2",
				args: ["hi", "2"],
				source: { url: "http://x/index.bundle", line: 10, col: 5 },
				stack: [{ file: "http://x/index.bundle", line: 10, col: 5, fn: "f" }],
			},
		]);
	});

	test("CDP types map onto the five levels", () => {
		const capture = createConsoleCapture({});
		for (const type of ["log", "info", "debug", "warning", "error", "assert", "dir", "table", "trace"]) {
			capture.handle(consoleEvent(type, [str(type)], { timestamp: Math.random() }));
		}
		expect(capture.lines().map((l) => l.level)).toEqual([
			"log",
			"info",
			"debug",
			"warn",
			"error",
			"error",
			"log",
			"log",
			"log",
		]);
	});

	test("Runtime.exceptionThrown becomes an error line with the exception text and position", () => {
		const capture = createConsoleCapture({});
		capture.handle({
			method: "Runtime.exceptionThrown",
			params: {
				timestamp: 77,
				exceptionDetails: {
					text: "Uncaught",
					url: "app.js",
					lineNumber: 2,
					columnNumber: 0,
					exception: { type: "object", subtype: "error", description: "TypeError: x is not a function" },
				},
			},
			connection: 1,
			replay: false,
		});
		expect(capture.lines()).toEqual([
			{
				ts: 77,
				level: "error",
				kind: "exception",
				text: "TypeError: x is not a function",
				source: { url: "app.js", line: 3, col: 1 },
			},
		]);
	});

	test("exception stackTrace call frames become 1-based stack frames", () => {
		const capture = createConsoleCapture({});
		capture.handle({
			method: "Runtime.exceptionThrown",
			params: {
				timestamp: 1,
				exceptionDetails: {
					text: "Uncaught",
					stackTrace: {
						callFrames: [
							{ url: "http://x/index.bundle", lineNumber: 0, columnNumber: 9, functionName: "boom" },
							{ lineNumber: 1, columnNumber: 1 },
						],
					},
				},
			},
			connection: 1,
			replay: false,
		});
		expect(capture.lines()[0]?.stack).toEqual([{ file: "http://x/index.bundle", line: 1, col: 10, fn: "boom" }]);
	});

	test("other events and malformed params are ignored", () => {
		const capture = createConsoleCapture({});
		capture.handle({ method: "Runtime.executionContextCreated", params: {}, connection: 1, replay: false });
		capture.handle({ method: "Runtime.consoleAPICalled", params: "nope", connection: 1, replay: false });
		expect(capture.lines()).toEqual([]);
	});

	test("ring keeps the newest lines", () => {
		const capture = createConsoleCapture({ ring: 3 });
		for (let i = 0; i < 5; i++) capture.handle(consoleEvent("log", [str(`m${i}`)], { timestamp: i }));
		expect(capture.lines().map((l) => l.text)).toEqual(["m2", "m3", "m4"]);
	});

	test("sink gets every new line, including marks", () => {
		const seen: ConsoleLine[] = [];
		const capture = createConsoleCapture({ sink: (line) => seen.push(line), now: () => 9 });
		capture.handle(consoleEvent("warning", [str("w")]));
		capture.mark("step 2");
		expect(seen.map((l) => [l.kind, l.text])).toEqual([
			["console", "w"],
			["note", "step 2"],
		]);
	});

	test("mark inserts a note line stamped with the clock; clear empties the buffer", () => {
		const capture = createConsoleCapture({ now: () => 4242 });
		capture.mark("before tap");
		expect(capture.lines()).toEqual([{ ts: 4242, level: "info", kind: "note", text: "before tap" }]);
		capture.clear();
		expect(capture.lines()).toEqual([]);
	});

	test("writeJsonl writes one JSON object per line, creating directories", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warden-console-"));
		dirs.push(dir);
		const capture = createConsoleCapture({ now: () => 1 });
		capture.handle(consoleEvent("error", [str("bad")], { timestamp: 2 }));
		capture.mark("m");
		const path = join(dir, "nested", "console.jsonl");
		await capture.writeJsonl(path);
		const rows = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows.map((r) => r.text)).toEqual(["bad", "m"]);
	});
});

describe("replay de-duplication", () => {
	const text = (capture: ReturnType<typeof createConsoleCapture>) => capture.lines().map((l) => l.text);

	test("a reconnect replays the buffer: seen (timestamp, text) pairs are dropped, new ones kept", () => {
		const capture = createConsoleCapture({});
		capture.handle(consoleEvent("log", [str("a")], { timestamp: 1, replay: true, connection: 1 }));
		capture.handle(consoleEvent("log", [str("b")], { timestamp: 2, replay: true, connection: 1 }));
		capture.handle(consoleEvent("log", [str("live")], { timestamp: 3, connection: 1 }));
		capture.handle(consoleEvent("log", [str("a")], { timestamp: 1, replay: true, connection: 2 }));
		capture.handle(consoleEvent("log", [str("b")], { timestamp: 2, replay: true, connection: 2 }));
		capture.handle(consoleEvent("log", [str("live")], { timestamp: 3, replay: true, connection: 2 }));
		capture.handle(consoleEvent("log", [str("missed")], { timestamp: 4, replay: true, connection: 2 }));
		expect(text(capture)).toEqual(["a", "b", "live", "missed"]);
	});

	test("two genuinely identical lines in one burst are both kept, and both dropped on the next replay", () => {
		const capture = createConsoleCapture({});
		for (let i = 0; i < 2; i++) {
			capture.handle(consoleEvent("log", [str("same")], { timestamp: 5, replay: true, connection: 1 }));
		}
		expect(text(capture)).toEqual(["same", "same"]);
		for (let i = 0; i < 2; i++) {
			capture.handle(consoleEvent("log", [str("same")], { timestamp: 5, replay: true, connection: 2 }));
		}
		expect(text(capture)).toEqual(["same", "same"]);
	});

	test("live lines are never de-duplicated (a loop logging within one millisecond)", () => {
		const capture = createConsoleCapture({});
		for (let i = 0; i < 3; i++) capture.handle(consoleEvent("log", [str("tick")], { timestamp: 9 }));
		expect(text(capture)).toEqual(["tick", "tick", "tick"]);
	});

	test("a second reconnect replays against the same history", () => {
		const capture = createConsoleCapture({});
		for (const connection of [1, 2, 3]) {
			capture.handle(consoleEvent("log", [str("a")], { timestamp: 1, replay: true, connection }));
		}
		expect(text(capture)).toEqual(["a"]);
	});

	test("clear() keeps the de-dupe history, so replayed old lines do not come back after it", () => {
		const capture = createConsoleCapture({});
		capture.handle(consoleEvent("log", [str("a")], { timestamp: 1, replay: true, connection: 1 }));
		capture.clear();
		capture.handle(consoleEvent("log", [str("a")], { timestamp: 1, replay: true, connection: 2 }));
		capture.handle(consoleEvent("log", [str("new")], { timestamp: 2, replay: true, connection: 2 }));
		expect(text(capture)).toEqual(["new"]);
	});
});

describe("attachConsole against a session", () => {
	/** Hermes-style: every `Runtime.enable` replays the buffered messages before it answers. */
	function replayingMetro() {
		const buffered = [
			{ type: "log", args: [str("early 1")], timestamp: 100 },
			{ type: "warning", args: [str("early 2")], timestamp: 101 },
		];
		return startFakeMetro({
			respond: (request, connection) => {
				if (request.method !== "Runtime.enable") return undefined;
				for (const message of buffered) connection.emit("Runtime.consoleAPICalled", message);
				return { result: {} };
			},
		});
	}

	test("live messages and exceptions arrive; a reconnect replay adds nothing twice", async () => {
		const fake = replayingMetro();
		cleanup.push(() => void fake.stop());
		const capture = createConsoleCapture({});
		const connected = await connectDevtools({
			metroUrl: fake.url,
			device: {},
			fetch,
			WebSocket,
			sleep: () => Bun.sleep(2),
			taps: [capture.handle],
		});
		if (!connected.success) throw new Error(connected.error.message);
		const session = connected.data;
		cleanup.push(() => session.close());

		expect(capture.lines().map((l) => l.text)).toEqual(["early 1", "early 2"]);

		fake.emit("Runtime.consoleAPICalled", { type: "error", args: [str("live")], timestamp: 200 });
		await Bun.sleep(30);
		const reconnected = new Promise<void>((resolve) => session.on("reconnected", () => resolve()));
		fake.dropAll();
		await reconnected;
		expect(capture.lines().map((l) => l.text)).toEqual(["early 1", "early 2", "live"]);
	});

	test("attachConsole after connect only sees what comes after it", async () => {
		const fake = replayingMetro();
		cleanup.push(() => void fake.stop());
		const connected = await connectDevtools({
			metroUrl: fake.url,
			device: {},
			fetch,
			WebSocket,
			sleep: () => Bun.sleep(2),
		});
		if (!connected.success) throw new Error(connected.error.message);
		const session = connected.data;
		cleanup.push(() => session.close());
		const capture = attachConsole(session, {});
		expect(capture.lines()).toEqual([]);
		fake.emit("Runtime.consoleAPICalled", { type: "info", args: [str("later")], timestamp: 300 });
		await Bun.sleep(30);
		expect(capture.lines().map((l) => [l.level, l.text])).toEqual([["info", "later"]]);
		capture.detach();
		fake.emit("Runtime.consoleAPICalled", { type: "info", args: [str("after detach")], timestamp: 301 });
		await Bun.sleep(30);
		expect(capture.lines()).toHaveLength(1);
	});
});
