import { expect, test } from "bun:test";
import { num, parseTpOutput } from "./tp-output";

test("quoted header and mixed cells", () => {
	const rows = parseTpOutput('"a","b"\n"x, y",3\n"say ""hi""",[NULL]\n');
	expect(rows).toEqual([
		{ a: "x, y", b: "3" },
		{ a: 'say "hi"', b: "[NULL]" },
	]);
	expect(num(rows[1] ?? {}, "b")).toBe(0);
	expect(num(rows[0] ?? {}, "b")).toBe(3);
});

test("skips log lines before the header, and handles an empty result", () => {
	expect(parseTpOutput('[0.1] loading trace\n"n"\n1\n')).toEqual([{ n: "1" }]);
	expect(parseTpOutput("")).toEqual([]);
	expect(parseTpOutput('"n"\n')).toEqual([]);
});
