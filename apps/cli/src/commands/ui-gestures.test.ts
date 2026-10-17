import { afterEach, describe, expect, test } from "bun:test";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { ScreenInfo } from "@delacour/warden-e2e/driver/driver.types";
import { parsePaths, splitAmount } from "../agent-ui/gestures";
import { cleanupHarnesses, doc, harness, LOGIN } from "./ui.testing";

afterEach(cleanupHarnesses);

const LIST = snapshotOf([
	el("window", { children: [el("list", { id: "list", frame: { x: 20, y: 100, width: 350, height: 400 } })] }),
]);
const SCREEN: ScreenInfo = { width: 390, height: 844, scale: 3 };
const CENTRE = { x: 195, y: 422 };

describe("splitAmount", () => {
	test("the last word is the amount, the rest the target", () => {
		expect(splitAmount(["2"], "scale")).toEqual({ success: true, data: { target: [], amount: 2 } });
		expect(splitAmount(["@e1", "0.5"], "scale")).toEqual({ success: true, data: { target: ["@e1"], amount: 0.5 } });
		expect(splitAmount(["10", "20", "1.5"], "scale")).toEqual({
			success: true,
			data: { target: ["10", "20"], amount: 1.5 },
		});
		expect(splitAmount(["id=list", "-45"], "degrees")).toEqual({
			success: true,
			data: { target: ["id=list"], amount: -45 },
		});
	});

	test("rejects out-of-range and non-numeric amounts and a lone coordinate", () => {
		for (const [words, kind] of [
			[["@e1", "0"], "scale"],
			[["@e1", "1"], "scale"],
			[["@e1", "11"], "scale"],
			[["@e1", "abc"], "scale"],
			[["200", "2"], "scale"],
			[["10", "20", "30", "2"], "scale"],
			[["@e1", "0"], "degrees"],
			[["@e1", "721"], "degrees"],
			[[], "scale"],
		] as const) {
			const split = splitAmount(words, kind);
			expect(split.success).toBe(false);
			if (!split.success) expect(split.error.hint).toContain("warden ui gesture");
		}
	});
});

describe("parsePaths", () => {
	test("points split on spaces or `;`, one or two paths", () => {
		expect(parsePaths(["10,20 30,40;50,60"], SCREEN)).toEqual({
			success: true,
			data: [
				[
					{ x: 10, y: 20 },
					{ x: 30, y: 40 },
					{ x: 50, y: 60 },
				],
			],
		});
		const two = parsePaths(["1,2 3,4", "5,6 7,8"], SCREEN);
		expect(two.success && two.data).toHaveLength(2);
	});

	test("rejects none, three, a single point, junk and off-screen points", () => {
		for (const raw of [[], ["1,1 2,2", "1,1 2,2", "1,1 2,2"], ["1,1"], ["1,1 a,b"], ["1,1 391,2"], ["1,1 2,-1"]]) {
			expect(parsePaths(raw, SCREEN).success).toBe(false);
		}
	});
});

describe("gesture pinch", () => {
	test("no target: around the screen centre", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "pinch", "2")).toBe(0);
		expect(h.driver.callsOf("pinch")).toEqual([
			{ method: "pinch", center: CENTRE, scale: 2, opts: { durationMs: 500, radius: 78 } },
		]);
	});

	test("an element: the centre of its visible rect", async () => {
		const h = harness([LIST]);
		expect(await h.run("gesture", "pinch", "id=list", "0.5")).toBe(0);
		expect(h.driver.callsOf("pinch")[0]).toMatchObject({ center: { x: 195, y: 300 }, scale: 0.5 });
	});

	test("x y <scale> pinches around that point", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "pinch", "100", "200", "2")).toBe(0);
		expect(h.driver.callsOf("pinch")[0]).toMatchObject({ center: { x: 100, y: 200 }, scale: 2 });
	});

	test("--duration and --radius go to the driver", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "pinch", "2", "--duration", "900", "--radius", "60")).toBe(0);
		expect(h.driver.callsOf("pinch")[0]).toMatchObject({ opts: { durationMs: 900, radius: 60 } });
	});

	test("a driver without two-finger support: exit 1, E_UNSUPPORTED, nothing sent", async () => {
		const h = harness([snapshotOf(LOGIN)], { capabilities: { pinch: false } });
		expect(await h.run("gesture", "pinch", "2", "--json")).toBe(1);
		expect(doc(h.c).error).toMatchObject({
			code: "failed",
			details: { driver: "E_UNSUPPORTED", capability: "pinch" },
		});
		expect(doc(h.c).error.hint).toContain("warden-uiad");
		expect(h.driver.callsOf("pinch")).toHaveLength(0);
	});

	test("usage errors: lone coordinate, zero, junk and 1 as the scale", async () => {
		for (const argv of [
			["200", "2"],
			["@e1", "0"],
			["@e1", "abc"],
			["@e1", "1"],
		]) {
			const h = harness([snapshotOf(LOGIN)]);
			expect(await h.run("gesture", "pinch", ...argv, "--json")).toBe(1);
			expect(doc(h.c).error.code).toBe("usage");
			expect(h.driver.callsOf("pinch")).toHaveLength(0);
		}
	});

	test("--json: command, action and the numbers used", async () => {
		const h = harness([LIST]);
		expect(await h.run("gesture", "pinch", "id=list", "2", "--json")).toBe(0);
		expect(doc(h.c)).toMatchObject({
			ok: true,
			command: "gesture pinch",
			result: {
				action: "gesture-pinch",
				target: { selector: "id=list" },
				scale: 2,
				center: { x: 195, y: 300 },
				radius: 70,
				durationMs: 500,
			},
		});
	});

	test("records the step, with the radius only when given", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("gesture", "pinch", "2");
		await h.run("gesture", "pinch", "0.5", "--radius", "50", "--duration", "700");
		expect(h.steps.map((step) => [step.action, step.args])).toEqual([
			["gesture-pinch", { scale: 2, ms: 500 }],
			["gesture-pinch", { scale: 0.5, ms: 700, radius: 50 }],
		]);
	});

	test("--settle reports what changed", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "pinch", "2", "--settle", "--json")).toBe(0);
		expect(doc(h.c).result.settled).toMatchObject({ quiet: true });
	});
});

describe("gesture rotate", () => {
	test("positive degrees around the screen centre", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "rotate", "90", "--json")).toBe(0);
		expect(h.driver.callsOf("rotate")[0]).toMatchObject({ center: CENTRE, degrees: 90, opts: { durationMs: 500 } });
		expect(doc(h.c)).toMatchObject({ command: "gesture rotate", result: { action: "gesture-rotate", degrees: 90 } });
	});

	test("negative degrees parse and reach the driver", async () => {
		const h = harness([LIST]);
		expect(await h.run("gesture", "rotate", "id=list", "-45")).toBe(0);
		expect(h.driver.callsOf("rotate")[0]).toMatchObject({ center: { x: 195, y: 300 }, degrees: -45 });
		expect(await h.run("gesture", "rotate", "-30")).toBe(0);
		expect(h.driver.callsOf("rotate")[1]).toMatchObject({ degrees: -30 });
	});

	test("0 degrees is a usage error", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "rotate", "0", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(h.driver.callsOf("rotate")).toHaveLength(0);
	});

	test("unsupported driver: E_UNSUPPORTED", async () => {
		const h = harness([snapshotOf(LOGIN)], { capabilities: { pinch: false } });
		expect(await h.run("gesture", "rotate", "45", "--json")).toBe(1);
		expect(doc(h.c).error.details).toMatchObject({ driver: "E_UNSUPPORTED" });
	});

	test("records the step", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("gesture", "rotate", "45");
		expect(h.steps[0]).toMatchObject({ action: "gesture-rotate", args: { degrees: 45, ms: 500 } });
	});
});

describe("gesture path", () => {
	test("one finger", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "path", "--path", "10,20 100,200 150,50", "--json")).toBe(0);
		expect(h.driver.callsOf("gesture")).toHaveLength(1);
		expect(h.driver.callsOf("gesture")[0]).toMatchObject({
			paths: [
				{
					points: [
						{ x: 10, y: 20 },
						{ x: 100, y: 200 },
						{ x: 150, y: 50 },
					],
				},
			],
			opts: { durationMs: 600 },
		});
		expect(doc(h.c)).toMatchObject({
			command: "gesture path",
			result: { action: "gesture-path", fingers: 1, durationMs: 600 },
		});
	});

	test("two fingers, --duration, and the recorded form", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(
			await h.run("gesture", "path", "--path", "100,400 100,200", "--path", "200,400;200,200", "--duration", "800")
		).toBe(0);
		expect(h.driver.callsOf("gesture")[0]?.paths).toHaveLength(2);
		expect(h.steps[0]).toMatchObject({
			action: "gesture-path",
			args: { paths: "100,400 100,200|200,400 200,200", ms: 800 },
		});
	});

	test("three paths, one point, an off-screen point and no --path are usage errors", async () => {
		for (const argv of [
			["--path", "1,1 2,2", "--path", "1,1 2,2", "--path", "1,1 2,2"],
			["--path", "5,5"],
			["--path", "10,10 999,10"],
			[],
		]) {
			const h = harness([snapshotOf(LOGIN)]);
			expect(await h.run("gesture", "path", ...argv, "--json")).toBe(1);
			expect(doc(h.c).error.code).toBe("usage");
			expect(h.driver.callsOf("gesture")).toHaveLength(0);
		}
	});

	test("two paths on a one-pointer driver: E_UNSUPPORTED; one path still works", async () => {
		const h = harness([snapshotOf(LOGIN)], { capabilities: { pinch: false, maxPointers: 1 } });
		expect(await h.run("gesture", "path", "--path", "1,1 9,9", "--path", "5,5 8,8", "--json")).toBe(1);
		expect(doc(h.c).error).toMatchObject({ code: "failed", details: { driver: "E_UNSUPPORTED", capability: "path" } });
		expect(h.driver.callsOf("gesture")).toHaveLength(0);
		expect(await h.run("gesture", "path", "--path", "1,1 9,9")).toBe(0);
		expect(h.driver.callsOf("gesture")).toHaveLength(1);
	});
});

describe("regrouped commands", () => {
	test("the old top-level names are unknown commands", async () => {
		for (const argv of [
			["rotate", "portrait"],
			["swipe", "up"],
			["longpress", "@e1"],
			["screenshot"],
			["appearance"],
			["video", "stop"],
		]) {
			const h = harness([snapshotOf(LOGIN)]);
			expect(await h.run(...argv)).toBe(1);
			expect(h.c.stderr.join("\n")).toContain("unknown command");
		}
	});

	test("the grouped commands name themselves with the group in --json", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("screen", "rotate", "portrait", "--json")).toBe(0);
		expect(doc(h.c)).toMatchObject({ command: "screen rotate", result: { action: "screen-rotate" } });
		expect(await h.run("gesture", "swipe", "up", "--json")).toBe(0);
		expect(doc(h.c)).toMatchObject({ command: "gesture swipe", result: { action: "gesture-swipe" } });
	});
});
