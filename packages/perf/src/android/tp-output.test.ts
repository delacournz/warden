import { expect, test } from "bun:test";
import { traceProcessorOutputParser } from "./tp-output";

test("quoted header and mixed cells", () => {
	const rows = traceProcessorOutputParser.parseTpOutput('"a","b"\n"x, y",3\n"say ""hi""",[NULL]\n');
	expect(rows).toEqual([
		{ a: "x, y", b: "3" },
		{ a: 'say "hi"', b: "[NULL]" },
	]);
	expect(traceProcessorOutputParser.num(rows[1] ?? {}, "b")).toBe(0);
	expect(traceProcessorOutputParser.num(rows[0] ?? {}, "b")).toBe(3);
});

test("skips log lines before the header, and handles an empty result", () => {
	expect(traceProcessorOutputParser.parseTpOutput('[0.1] loading trace\n"n"\n1\n')).toEqual([{ n: "1" }]);
	expect(traceProcessorOutputParser.parseTpOutput("")).toEqual([]);
	expect(traceProcessorOutputParser.parseTpOutput('"n"\n')).toEqual([]);
});
