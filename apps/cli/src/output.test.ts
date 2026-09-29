import { describe, expect, test } from "bun:test";
import { formatTable } from "./output";

describe("formatTable", () => {
	test("pads columns", () => {
		expect(formatTable(["A", "BB"], [["xxx", "y"]])).toBe("A    BB\nxxx  y");
	});
});
