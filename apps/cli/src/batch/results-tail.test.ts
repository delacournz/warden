import { describe, expect, test } from "bun:test";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { jsonl, memoryReadFrom, result } from "./results.testing";
import { createResultsTail, parseResultLine } from "./results-tail";

const file = "/app/e2e/todos.e2e.ts";
const encoder = new TextEncoder();

/** A tail over an in-memory file, with every parser call and every read offset logged. */
function tailOf(files: Map<string, string | Uint8Array>) {
	const parsed: string[] = [];
	const offsets: number[] = [];
	const read = memoryReadFrom(files);
	const tail = createResultsTail(
		"/out/results.jsonl",
		async (path, offset) => {
			offsets.push(offset);
			return read(path, offset);
		},
		(line) => {
			parsed.push(line);
			return parseResultLine(line);
		}
	);
	return { tail, parsed, offsets };
}

const titles = (results: readonly TestResult[]) => results.map((r) => r.title.join(" › "));

describe("parseResultLine", () => {
	test("a valid result; blank, truncated and invalid lines are skipped", () => {
		const line = JSON.stringify(result(file, "add"));
		expect(parseResultLine(line)?.title).toEqual(["add"]);
		expect(parseResultLine("")).toBeUndefined();
		expect(parseResultLine("   ")).toBeUndefined();
		expect(parseResultLine(line.slice(0, 20))).toBeUndefined();
		expect(parseResultLine('{"file":1}')).toBeUndefined();
	});
});

describe("createResultsTail", () => {
	test("parses each line exactly once across many polls", async () => {
		const files = new Map<string, string>();
		const { tail, parsed } = tailOf(files);
		let text = "";
		const seen: string[] = [];
		for (let i = 0; i < 50; i++) {
			text += jsonl(result(file, `t${i}`), result(file, `u${i}`));
			files.set("/out/results.jsonl", text);
			const polled = await tail.poll();
			seen.push(...titles(polled.results));
			expect(polled.reset).toBe(false);
		}
		for (let i = 0; i < 10; i++) expect((await tail.poll()).results).toEqual([]);
		expect(parsed).toHaveLength(100);
		expect(new Set(parsed).size).toBe(100);
		expect(seen).toHaveLength(100);
		expect(seen.slice(0, 4)).toEqual(["t0", "u0", "t1", "u1"]);
	});

	test("an unchanged file is not re-read past the offset", async () => {
		const files = new Map([["/out/results.jsonl", jsonl(result(file, "a"), result(file, "b"))]]);
		const { tail, offsets } = tailOf(files);
		await tail.poll();
		await tail.poll();
		await tail.poll();
		const size = encoder.encode(files.get("/out/results.jsonl")).length;
		expect(offsets).toEqual([0, size, size]);
	});

	test("a partial trailing line waits for its newline, then parses once", async () => {
		const files = new Map<string, string>();
		const { tail, parsed, offsets } = tailOf(files);
		const first = jsonl(result(file, "whole"));
		const second = jsonl(result(file, "split"));
		files.set("/out/results.jsonl", first + second.slice(0, 30));
		expect(titles((await tail.poll()).results)).toEqual(["whole"]);
		expect(parsed).toHaveLength(1);
		expect((await tail.poll()).results).toEqual([]);
		expect(parsed).toHaveLength(1);
		files.set("/out/results.jsonl", first + second);
		expect(titles((await tail.poll()).results)).toEqual(["split"]);
		expect(parsed).toHaveLength(2);
		expect(offsets).toEqual([0, encoder.encode(first).length, encoder.encode(first).length]);
	});

	test("a multi-byte character cut by the read end is decoded whole once its line completes", async () => {
		const files = new Map<string, string | Uint8Array>();
		const { tail } = tailOf(files);
		const bytes = encoder.encode(jsonl(result(file, "✓ sign-in → ok")));
		files.set("/out/results.jsonl", bytes.subarray(0, bytes.indexOf(0xe2) + 1));
		expect((await tail.poll()).results).toEqual([]);
		files.set("/out/results.jsonl", bytes);
		expect(titles((await tail.poll()).results)).toEqual(["✓ sign-in → ok"]);
	});

	test("invalid and blank lines are consumed once and skipped", async () => {
		const files = new Map([["/out/results.jsonl", `not json\n\n${jsonl(result(file, "ok"))}`]]);
		const { tail, parsed } = tailOf(files);
		expect(titles((await tail.poll()).results)).toEqual(["ok"]);
		expect((await tail.poll()).results).toEqual([]);
		expect(parsed).toHaveLength(3);
	});

	test("a missing file reads as nothing yet and is picked up when it appears", async () => {
		const files = new Map<string, string>();
		const { tail } = tailOf(files);
		expect(await tail.poll()).toEqual({ results: [], reset: false });
		files.set("/out/results.jsonl", jsonl(result(file, "late")));
		expect(titles((await tail.poll()).results)).toEqual(["late"]);
	});

	test("a file that shrinks (truncated or replaced) is read again from the start and flagged", async () => {
		const files = new Map<string, string>();
		const { tail } = tailOf(files);
		files.set("/out/results.jsonl", jsonl(result(file, "a"), result(file, "b"), result(file, "c")));
		expect(titles((await tail.poll()).results)).toEqual(["a", "b", "c"]);
		files.set("/out/results.jsonl", jsonl(result(file, "x")));
		const again = await tail.poll();
		expect(again.reset).toBe(true);
		expect(titles(again.results)).toEqual(["x"]);
		files.set("/out/results.jsonl", jsonl(result(file, "x"), result(file, "y")));
		const next = await tail.poll();
		expect(next.reset).toBe(false);
		expect(titles(next.results)).toEqual(["y"]);
	});

	test("a read that fails reads as nothing new and keeps the offset", async () => {
		const files = new Map([["/out/results.jsonl", jsonl(result(file, "a"))]]);
		let broken = false;
		const read = memoryReadFrom(files);
		const tail = createResultsTail("/out/results.jsonl", async (path, offset) => {
			if (broken) throw new Error("EIO");
			return read(path, offset);
		});
		expect(titles((await tail.poll()).results)).toEqual(["a"]);
		broken = true;
		expect((await tail.poll()).results).toEqual([]);
		broken = false;
		files.set("/out/results.jsonl", jsonl(result(file, "a"), result(file, "b")));
		expect(titles((await tail.poll()).results)).toEqual(["b"]);
	});
});
