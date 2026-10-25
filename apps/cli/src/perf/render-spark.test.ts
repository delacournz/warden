import { describe, expect, test } from "bun:test";
import { eraseLines, renderWatch, sparkline } from "./render-spark";

describe("sparkline", () => {
	test("scales 0..max by default", () => {
		expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe("▁▂▃▄▅▆▇█");
	});
	test("min floor stretches a narrow band", () => {
		expect(sparkline([300, 301, 302, 303], 4, "min")).toBe("▁▃▆█");
		expect(sparkline([300, 301, 302, 303], 4, "zero")).toBe("████");
	});
	test("keeps the last `width` values and pads short series to width", () => {
		expect(sparkline([0, 0, 0, 7], 2)).toBe("▁█");
		expect(sparkline([7], 4)).toBe("█   ");
	});
	test("flat and empty series", () => {
		expect(sparkline([5, 5, 5], 3, "min")).toBe("▁▁▁");
		expect(sparkline([], 3)).toBe("   ");
	});
});

describe("renderWatch", () => {
	const frame = {
		title: "com.example.app on warden-pixel (android)",
		elapsedMs: 12_400,
		rows: [
			{ label: "cpu", unit: "%" as const, floor: "zero" as const, values: [2, 4, 8, 16, 32, 8] },
			{ label: "mem", unit: "MB" as const, floor: "min" as const, values: [200, 201, 203, 206, 210, 215] },
			{ label: "fps", unit: "fps" as const, floor: "zero" as const, values: [] },
		],
	};

	test("snapshot", () => {
		expect(renderWatch(frame, 80)).toEqual([
			"com.example.app on warden-pixel (android)  +12s  ctrl-c to stop",
			"cpu  ▁▂▃▅█▃                        cur 8.0%  avg 11.7%  max 32.0%",
			"mem  ▁▁▂▄▆█                        cur 215 MB  avg 206 MB  max 215 MB",
			"fps                                waiting",
		]);
	});

	test("the dim hook wraps only the secondary figures", () => {
		const lines = renderWatch(frame, 80, (s) => `<${s}>`);
		expect(lines[1]).toContain("<avg 11.7%  max 32.0%>");
		expect(lines[0]).toContain("<+12s  ctrl-c to stop>");
	});

	test("narrow terminals shrink the line, never below 10 cells", () => {
		const lines = renderWatch(frame, 20);
		expect(lines[1]?.startsWith(`cpu  ${sparkline(frame.rows[0]?.values ?? [], 10)}  cur`)).toBe(true);
	});
});

describe("eraseLines", () => {
	test("moves up and clears; nothing for 0", () => {
		expect(eraseLines(4)).toBe("\x1b[4A\x1b[J");
		expect(eraseLines(0)).toBe("");
	});
});
