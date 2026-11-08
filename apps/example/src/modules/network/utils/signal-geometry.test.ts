import { describe, expect, test } from "bun:test";
import { ARC_RADII, arcPath, litArcs } from "./signal-geometry";

describe("arcPath", () => {
	test("is one arc command, sized by the radius", () => {
		const d = arcPath(60);
		expect(d.startsWith("M")).toBe(true);
		expect(d).toContain("A 60 60");
	});
	test("three radii, inner to outer", () => {
		expect(ARC_RADII).toHaveLength(3);
		expect([...ARC_RADII].sort((a, b) => a - b)).toEqual([...ARC_RADII]);
	});
});

describe("litArcs", () => {
	test("quality counts the lit arcs from the inside out", () => {
		expect(litArcs(0)).toEqual([false, false, false]);
		expect(litArcs(2)).toEqual([true, true, false]);
		expect(litArcs(3)).toEqual([true, true, true]);
	});
});
