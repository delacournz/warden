import { describe, expect, test } from "bun:test";
import { barChart, barPath, boxChart, linearScale, niceTicks, tickMs } from "./svg";

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const meta = { id: "t", title: "T <x>", desc: "D", tickLabel: tickMs };

describe("scales and ticks", () => {
	test("linearScale maps the domain onto the range and tolerates a flat domain", () => {
		const s = linearScale([0, 10], [100, 200]);
		expect([s(0), s(5), s(10)]).toEqual([100, 150, 200]);
		expect(linearScale([3, 3], [7, 9])(3)).toBe(7);
	});
	test("niceTicks starts at 0, ends at or above max, with clean steps", () => {
		expect(niceTicks(97)).toEqual([0, 25, 50, 75, 100]);
		expect(niceTicks(61410)).toEqual([0, 20000, 40000, 60000, 80000]);
		const t = niceTicks(0.7);
		expect(t[0]).toBe(0);
		expect(t[t.length - 1]).toBeGreaterThanOrEqual(0.7);
		expect(niceTicks(0)).toEqual([0, 1]);
		expect(niceTicks(Number.NaN)).toEqual([0, 1]);
	});
	test("tickMs is compact", () => {
		expect([tickMs(0), tickMs(500), tickMs(1500), tickMs(20000)]).toEqual(["0", "500 ms", "1.5 s", "20 s"]);
	});
});

describe("barPath", () => {
	test("square at the baseline, rounded data end, never wider than asked", () => {
		expect(barPath(8, 10, 100, 14)).toBe("M8 10 h96 a4 4 0 0 1 4 4 v6 a4 4 0 0 1 -4 4 h-96 z");
		expect(barPath(0, 0, 0, 14)).toContain("h0");
	});
});

describe("barChart", () => {
	const svg = barChart({
		...meta,
		desc: "d",
		groups: [
			{
				label: "A",
				bars: [
					{ series: "warden", value: 100, label: "100", whiskerTo: 120, marker: 150, best: true },
					{ series: "maestro", value: 200, label: "200" },
				],
			},
			{ label: "empty", bars: [] },
		],
	});
	test("one mark per bar, one group per non-empty group, labelled", () => {
		expect(count(svg, '<path class="mark"')).toBe(2);
		expect(count(svg, 'class="grp"')).toBe(1);
		expect(count(svg, "<circle")).toBe(1);
		expect(count(svg, 'class="whisker"')).toBe(2);
		expect(svg).toContain('role="img"');
		expect(svg).toContain("<title");
		expect(svg).toContain("T &lt;x&gt;");
		expect(svg).toContain('class="val best"');
		expect(svg).toContain("s-warden");
	});
	test("is pure", () => {
		expect(svg).toBe(
			barChart({
				...meta,
				desc: "d",
				groups: [
					{
						label: "A",
						bars: [
							{ series: "warden", value: 100, label: "100", whiskerTo: 120, marker: 150, best: true },
							{ series: "maestro", value: 200, label: "200" },
						],
					},
					{ label: "empty", bars: [] },
				],
			})
		);
	});
});

describe("boxChart", () => {
	const svg = boxChart({
		...meta,
		groups: [
			{
				label: "G",
				boxes: [
					{ series: "warden", min: 10, median: 20, p95: 30, max: 40, label: "20" },
					{ series: "argent", min: 15, median: 15, p95: 15, max: 15, label: "15" },
				],
			},
		],
	});
	test("a box, whisker pair, and median tick per row", () => {
		expect(count(svg, '<rect class="box"')).toBe(2);
		expect(count(svg, 'class="median"')).toBe(2);
		expect(count(svg, 'class="boxrow')).toBe(2);
		expect(svg).not.toContain("NaN");
	});
});
