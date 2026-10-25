import { describe, expect, test } from "bun:test";
import { jsonl, memoryReadFrom, result } from "./results.testing";
import { parseResultLine, type ReadFrom } from "./results-tail";
import { type SpecSink, specPoller } from "./spec-poller";
import type { SpecMark, TrackedSpec } from "./spec-progress";

const specs: TrackedSpec[] = ["onboarding", "settings", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const OUT = "/out/1-0/results.jsonl";

/** A poller over in-memory files, a timer the test fires by hand, and a log of everything it reports. */
function rig(initial: Record<string, string> = {}) {
	const files = new Map<string, string | Uint8Array>(Object.entries(initial));
	const resultFiles = new Map<string, string>([["1:0", OUT]]);
	const ended = new Set<string>();
	const parsed: string[] = [];
	const marks: Array<{ worker: number; marks: Record<string, SpecMark> }> = [];
	const lines: string[] = [];
	const sink: SpecSink = {
		specs: (worker, m) => marks.push({ worker, marks: { ...m } }),
		tests: (l) => lines.push(...l),
	};
	let reads = 0;
	let fire: () => void = () => {};
	let stopped = false;
	const memory = memoryReadFrom(files);
	const readFrom: ReadFrom = async (path, offset) => {
		reads++;
		return memory(path, offset);
	};
	const poller = specPoller(
		{
			every: (_ms, fn) => {
				fire = fn;
				return () => {
					stopped = true;
				};
			},
			readFrom,
			parse: (line) => {
				parsed.push(line);
				return parseResultLine(line);
			},
		},
		specs,
		resultFiles,
		ended,
		sink
	);
	return {
		files,
		resultFiles,
		ended,
		parsed,
		marks,
		lines,
		poller,
		tick: async () => {
			fire();
			await Bun.sleep(0);
			await poller.poll();
		},
		reads: () => reads,
		stopped: () => stopped,
	};
}

describe("specPoller", () => {
	test("parses each result line exactly once however many ticks pass", async () => {
		const r = rig();
		let text = "";
		for (let i = 0; i < 40; i++) {
			text += jsonl(result(file("todos"), `a${i}`), result(file("todos"), `b${i}`));
			r.files.set(OUT, text);
			await r.tick();
		}
		for (let i = 0; i < 20; i++) await r.tick();
		expect(r.parsed).toHaveLength(80);
		expect(new Set(r.parsed).size).toBe(80);
		expect(r.lines).toHaveLength(80);
		expect(r.lines[0]).toBe("✓ todos › a0 (1.25s)");
	});

	test("a partial trailing line is not parsed or reported until its newline arrives", async () => {
		const r = rig();
		const first = jsonl(result(file("onboarding"), "welcome"));
		const second = jsonl(result(file("settings"), "toggle"));
		r.files.set(OUT, first + second.slice(0, 40));
		await r.tick();
		await r.tick();
		expect(r.parsed).toHaveLength(1);
		expect(r.lines).toEqual(["✓ onboarding › welcome (1.25s)"]);
		r.files.set(OUT, first + second);
		await r.tick();
		expect(r.parsed).toHaveLength(2);
		expect(r.lines).toEqual(["✓ onboarding › welcome (1.25s)", "✓ settings › toggle (1.25s)"]);
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { onboarding: "passed" } });
	});

	test("the grid hears about a file only when its marks can have changed", async () => {
		const r = rig();
		await r.tick();
		expect(r.marks).toEqual([]);
		r.files.set(OUT, jsonl(result(file("onboarding"), "welcome")));
		await r.tick();
		await r.tick();
		await r.tick();
		expect(r.marks).toEqual([{ worker: 1, marks: {} }]);
		r.files.set(OUT, jsonl(result(file("onboarding"), "welcome"), result(file("settings"), "toggle")));
		await r.tick();
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { onboarding: "passed" } });
		expect(r.marks).toHaveLength(2);
	});

	test("an ended job's specs are all marked once, its file is read a last time, and then it is left alone", async () => {
		const r = rig({ [OUT]: jsonl(result(file("todos"), "add"), result(file("todos"), "remove", "failed")) });
		await r.tick();
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { todos: "failed" } });
		r.files.set(OUT, `${r.files.get(OUT) as string}${jsonl(result(file("settings"), "toggle"))}`);
		r.ended.add("1:0");
		await r.poller.poll();
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { todos: "failed", settings: "passed" } });
		const reads = r.reads();
		const sent = r.marks.length;
		await r.tick();
		await r.tick();
		expect(r.reads()).toBe(reads);
		expect(r.marks).toHaveLength(sent);
	});

	test("jobs that start later are followed from their first line; each file keeps its own offset", async () => {
		const r = rig({ [OUT]: jsonl(result(file("todos"), "a")) });
		await r.tick();
		r.resultFiles.set("2:0", "/out/2-0/results.jsonl");
		r.files.set("/out/2-0/results.jsonl", jsonl(result(file("settings"), "s1"), result(file("settings"), "s2")));
		await r.tick();
		expect(r.lines).toEqual(["✓ todos › a (1.25s)", "✓ settings › s1 (1.25s)", "✓ settings › s2 (1.25s)"]);
		expect(r.marks.at(-1)).toEqual({ worker: 2, marks: {} });
		expect(r.parsed).toHaveLength(3);
	});

	test("a file that is truncated is read again from the start", async () => {
		const r = rig({ [OUT]: jsonl(result(file("todos"), "a"), result(file("todos"), "b"), result(file("todos"), "c")) });
		await r.tick();
		r.files.set(OUT, jsonl(result(file("settings"), "fresh")));
		await r.tick();
		expect(r.lines.at(-1)).toBe("✓ settings › fresh (1.25s)");
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: {} });
		r.ended.add("1:0");
		await r.poller.poll();
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { settings: "passed" } });
	});

	test("a later pass's results file replaces the earlier pass's for the same attempt (batch-pipeline R2)", async () => {
		const r = rig({ [OUT]: jsonl(result(file("todos"), "a")) });
		await r.tick();
		const pass1 = "/out/1-0-p1/results.jsonl";
		r.resultFiles.set("1:0", pass1);
		r.files.set(pass1, jsonl(result(file("todos"), "a", "failed")));
		await r.tick();
		expect(r.lines).toEqual(["✓ todos › a (1.25s)", "✗ todos › a (1.25s)"]);
		r.ended.add("1:0");
		await r.poller.poll();
		expect(r.marks.at(-1)).toEqual({ worker: 1, marks: { todos: "failed" } });
	});

	test("results of files that are not tracked make no line", async () => {
		const r = rig({ [OUT]: jsonl(result("/app/e2e/other.e2e.ts", "x")) });
		await r.tick();
		expect(r.lines).toEqual([]);
	});

	test("poll waits for a look under way, then looks again, so the last results are never missed", async () => {
		const files = new Map<string, string | Uint8Array>([[OUT, jsonl(result(file("todos"), "a"))]]);
		const memory = memoryReadFrom(files);
		let release: () => void = () => {};
		let gate: Promise<void> | undefined = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lines: string[] = [];
		let fire: () => void = () => {};
		const poller = specPoller(
			{
				every: (_ms, fn) => {
					fire = fn;
					return () => {};
				},
				readFrom: async (path, offset) => {
					const read = await memory(path, offset);
					await gate;
					return read;
				},
			},
			specs,
			new Map([["1:0", OUT]]),
			new Set(),
			{ specs: () => {}, tests: (l) => lines.push(...l) }
		);
		fire();
		await Bun.sleep(0);
		files.set(OUT, `${files.get(OUT) as string}${jsonl(result(file("todos"), "b"))}`);
		const last = poller.poll();
		gate = undefined;
		release();
		await last;
		expect(lines).toEqual(["✓ todos › a (1.25s)", "✓ todos › b (1.25s)"]);
	});

	test("stop ends the timer", () => {
		const r = rig();
		r.poller.stop();
		expect(r.stopped()).toBe(true);
	});
});
