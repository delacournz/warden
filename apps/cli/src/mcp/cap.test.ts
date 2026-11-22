import { describe, expect, test } from "bun:test";
import { capValue, MAX_RESPONSE_CHARS, MAX_STRING_CHARS } from "./cap";

const size = (value: unknown): number => JSON.stringify(value).length;

describe("capValue", () => {
	test("a value under the limits comes back as it is, with no notes", () => {
		const value = { file: "/x", total: 2, lines: [{ text: "a" }, { text: "b" }] };
		expect(capValue(value, { keep: "last" })).toEqual({ fits: true, value, notes: [] });
	});

	test("a long string in a reply within the limit is left whole", () => {
		const value = { value: "x".repeat(MAX_STRING_CHARS + 500) };
		expect(capValue(value, { keep: "last" })).toEqual({ fits: true, value, notes: [] });
	});

	test("over the limit, a long string is cut in place and says how much is missing", () => {
		const extra = MAX_RESPONSE_CHARS;
		const capped = capValue({ lines: [{ text: "x".repeat(MAX_STRING_CHARS + extra) }] }, { keep: "last" });
		const [line] = (capped.value as { lines: { text: string }[] }).lines;
		expect(line?.text).toBe(`${"x".repeat(MAX_STRING_CHARS)}… [truncated ${extra} chars]`);
		expect(capped.fits).toBe(true);
		expect(capped.notes).toEqual([`1 string cut at ${MAX_STRING_CHARS} chars`]);
	});

	test("a result's own truncated flag turns true when one of its lists is shortened", () => {
		const components = Array.from({ length: 400 }, (_, i) => ({ id: i, name: "z".repeat(500) }));
		const capped = capValue({ components, truncated: false }, { keep: "first" });
		expect((capped.value as { truncated: boolean }).truncated).toBe(true);
	});

	test("too many entries: the oldest are dropped until it fits, the shape is kept", () => {
		const lines = Array.from({ length: 400 }, (_, i) => ({ ts: i, text: "y".repeat(500) }));
		const capped = capValue({ file: "/x", total: 400, lines }, { keep: "last" });
		const out = capped.value as { file: string; total: number; lines: { ts: number }[] };
		expect(capped.fits).toBe(true);
		expect(size(out)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(out.file).toBe("/x");
		expect(out.total).toBe(400);
		expect(out.lines.at(-1)?.ts).toBe(399);
		expect(out.lines.length).toBeLessThan(400);
		expect(out.lines.length).toBeGreaterThan(50);
		expect(capped.notes).toEqual([`lines: the last ${out.lines.length} of 400 kept`]);
	});

	test('keep "first" drops from the end', () => {
		const components = Array.from({ length: 400 }, (_, i) => ({ id: i, name: "z".repeat(500) }));
		const capped = capValue({ components, truncated: false }, { keep: "first" });
		const out = capped.value as { components: { id: number }[] };
		expect(out.components[0]?.id).toBe(0);
		expect(out.components.length).toBeLessThan(400);
		expect(capped.notes).toEqual([`components: the first ${out.components.length} of 400 kept`]);
	});

	test("a result that is a list itself is cut the same way", () => {
		const entries = Array.from({ length: 400 }, (_, i) => ({ n: i, text: "w".repeat(500) }));
		const capped = capValue(entries, { keep: "last" });
		const out = capped.value as { n: number }[];
		expect(size(out)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(out.at(-1)?.n).toBe(399);
		expect(capped.notes).toEqual([`entries: the last ${out.length} of 400 kept`]);
	});

	test("several lists: the largest is cut first, a small one is left whole", () => {
		const big = Array.from({ length: 400 }, () => "v".repeat(500));
		const capped = capValue({ small: ["a", "b"], big }, { keep: "last" });
		const out = capped.value as { small: string[]; big: string[] };
		expect(out.small).toEqual(["a", "b"]);
		expect(out.big.length).toBeLessThan(400);
	});

	test("nothing left to drop and still too large → does not fit", () => {
		const value: Record<string, string> = {};
		for (let i = 0; i < 400; i++) value[`key${i}`] = "u".repeat(500);
		expect(capValue({ value }, { keep: "last" }).fits).toBe(false);
	});

	test("the limits can be set per call", () => {
		const capped = capValue({ lines: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"] }, { keep: "last", maxChars: 30 });
		expect(capValue({ lines: ["aaaaaaaaaa"] }, { keep: "last", maxChars: 30 }).notes).toEqual([]);
		expect(capped.value).toEqual({ lines: ["cccccccccc"] });
	});
});
