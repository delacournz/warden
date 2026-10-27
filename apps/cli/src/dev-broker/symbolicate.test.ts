import { describe, expect, test } from "bun:test";
import type { ConsoleLine } from "@delacour/warden-e2e/devtools/devtools.types";
import { ok } from "@delacour/warden-types/result";
import type { Broker } from "./broker";
import type { LineProcessor } from "./broker.types";
import { BROKER_EXTENSIONS } from "./extensions";
import { createSymbolicator, symbolicateExtension, symbolicateFrames } from "./symbolicate";

const BUNDLE = "http://localhost:8081/index.bundle?platform=ios&dev=true";

type Posted = { stack: { file: string; lineNumber: number; column: number; methodName?: string }[] };

function fakeMetro(options: { fail?: boolean; hang?: boolean } = {}) {
	const posts: Posted[] = [];
	const fetch = async (url: string, init: { method: string; body: string; signal: AbortSignal }) => {
		expect(url).toBe("http://localhost:8081/symbolicate");
		expect(init.method).toBe("POST");
		posts.push(JSON.parse(init.body) as Posted);
		if (options.hang)
			await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
		if (options.fail) return { ok: false, status: 500, text: async () => "{}" };
		const body = {
			stack: posts[posts.length - 1]?.stack.map((f) => ({
				file: f.lineNumber === 99 ? "/app/node_modules/react-native/x.js" : "/app/src/App.tsx",
				lineNumber: f.lineNumber + 1000,
				column: f.column + 1,
				methodName: f.methodName ?? "<anon>",
				collapse: f.lineNumber === 99,
			})),
			codeFrame: { content: "> 1 | frame", fileName: "/app/src/App.tsx", location: { row: 1, column: 0 } },
		};
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	return { fetch, posts };
}

const exception = (line = 5): ConsoleLine => ({
	ts: 1,
	level: "error",
	kind: "exception",
	text: "TypeError: x",
	source: { url: BUNDLE, line, col: 3 },
	stack: [
		{ file: BUNDLE, line, col: 3, fn: "boom" },
		{ file: BUNDLE, line: 99, col: 1 },
		{ file: "native", line: 1, col: 1 },
	],
});

describe("symbolicateFrames", () => {
	test("sends 1-based line / 0-based column and maps the reply", async () => {
		const metro = fakeMetro();
		const result = await symbolicateFrames("http://localhost:8081", [{ file: BUNDLE, line: 5, col: 3, fn: "boom" }], {
			fetch: metro.fetch,
			timeoutMs: 500,
		});
		expect(metro.posts[0]?.stack).toEqual([{ file: BUNDLE, lineNumber: 5, column: 2, methodName: "boom" }]);
		expect(result).toEqual({
			success: true,
			data: {
				frames: [{ file: "/app/src/App.tsx", line: 1005, col: 4, fn: "boom", collapsed: false }],
				codeFrame: "> 1 | frame",
			},
		});
	});

	test("errors on a non-200 reply or a timeout", async () => {
		const failed = await symbolicateFrames("http://localhost:8081", [{ file: BUNDLE, line: 1, col: 1 }], {
			fetch: fakeMetro({ fail: true }).fetch,
			timeoutMs: 500,
		});
		expect(failed.success).toBe(false);
		const hung = await symbolicateFrames("http://localhost:8081", [{ file: BUNDLE, line: 1, col: 1 }], {
			fetch: fakeMetro({ hang: true }).fetch,
			timeoutMs: 20,
		});
		expect(hung.success).toBe(false);
	});
});

describe("symbolicator line processor", () => {
	test("rewrites exceptions: only bundle frames sent, collapsed kept flagged, source and codeFrame set", async () => {
		const metro = fakeMetro();
		const process = createSymbolicator("http://localhost:8081", { fetch: metro.fetch, timeoutMs: 500 }).process;
		const out = await process(exception());
		expect(metro.posts[0]?.stack.map((f) => f.lineNumber)).toEqual([5, 99]);
		expect(out.stack).toEqual([
			{ file: "/app/src/App.tsx", line: 1005, col: 4, fn: "boom", collapsed: false },
			{ file: "/app/node_modules/react-native/x.js", line: 1099, col: 2, fn: "<anon>", collapsed: true },
			{ file: "native", line: 1, col: 1 },
		]);
		expect(out.source).toEqual({ url: "/app/src/App.tsx", line: 1005, col: 4 });
		expect(out.codeFrame).toBe("> 1 | frame");
		expect(out.text).toBe("TypeError: x");
	});

	test("lines without bundle frames pass untouched and cost no request", async () => {
		const metro = fakeMetro();
		const process = createSymbolicator("http://localhost:8081", { fetch: metro.fetch, timeoutMs: 500 }).process;
		const note: ConsoleLine = { ts: 1, level: "info", kind: "note", text: "mark" };
		const plain: ConsoleLine = {
			ts: 1,
			level: "log",
			kind: "console",
			text: "hi",
			source: { url: "native", line: 1, col: 1 },
		};
		expect(await process(note)).toBe(note);
		expect(await process(plain)).toBe(plain);
		expect(metro.posts).toHaveLength(0);
	});

	test("console line with only a bundle source is symbolicated through it", async () => {
		const metro = fakeMetro();
		const process = createSymbolicator("http://localhost:8081", { fetch: metro.fetch, timeoutMs: 500 }).process;
		const out = await process({
			ts: 1,
			level: "log",
			kind: "console",
			text: "hi",
			source: { url: BUNDLE, line: 5, col: 3 },
		});
		expect(out.source).toEqual({ url: "/app/src/App.tsx", line: 1005, col: 4 });
	});

	test("caches per bundle + frame; invalidate() and a changed bundle URL refetch", async () => {
		const metro = fakeMetro();
		const sym = createSymbolicator("http://localhost:8081", { fetch: metro.fetch, timeoutMs: 500 });
		await sym.process(exception());
		await sym.process(exception());
		expect(metro.posts).toHaveLength(1);
		sym.invalidate();
		await sym.process(exception());
		expect(metro.posts).toHaveLength(2);
		const other = exception();
		const moved = {
			...other,
			source: undefined,
			stack: other.stack?.map((f) => (f.file === BUNDLE ? { ...f, file: `${BUNDLE}&x=1` } : f)),
		};
		await sym.process(moved);
		expect(metro.posts).toHaveLength(3);
	});

	test("a new bundle URL drops cached frames of the old one", async () => {
		const metro = fakeMetro();
		const sym = createSymbolicator("http://localhost:8081", { fetch: metro.fetch, timeoutMs: 500 });
		await sym.process(exception());
		const next = {
			...exception(),
			stack: [{ file: "http://localhost:8081/other.bundle", line: 5, col: 3 }],
			source: undefined,
		};
		await sym.process(next);
		await sym.process(exception());
		expect(metro.posts).toHaveLength(3);
	});

	test("failure or timeout returns the line unchanged", async () => {
		const line = exception();
		for (const options of [{ fail: true }, { hang: true }]) {
			const sym = createSymbolicator("http://localhost:8081", { fetch: fakeMetro(options).fetch, timeoutMs: 20 });
			expect(await sym.process(line)).toBe(line);
		}
	});
});

describe("symbolicateExtension", () => {
	test("is installed by default", () => {
		expect(BROKER_EXTENSIONS).toContain(symbolicateExtension);
	});

	test("registers a processor and an attach hook, and removes both on teardown", async () => {
		const events: string[] = [];
		let attach: (() => void) | undefined;
		let processor: LineProcessor | undefined;
		const broker = {
			addLineProcessor: (p: LineProcessor) => {
				processor = p;
				events.push("processor added");
				return () => events.push("processor removed");
			},
			onAttach: (handler: () => void) => {
				attach = handler;
				return () => events.push("attach removed");
			},
			registerMethod: () => ok(() => undefined),
		} as unknown as Broker;
		const teardown = symbolicateExtension(broker, {
			metroUrl: "http://localhost:8081",
			logDir: "/d",
			log: () => undefined,
		});
		expect(processor).toBeDefined();
		expect(attach).toBeDefined();
		teardown();
		expect(events).toEqual(["processor added", "processor removed", "attach removed"]);
	});
});
