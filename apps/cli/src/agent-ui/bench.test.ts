import { afterEach, describe, expect, test } from "bun:test";
import type { Platform } from "@delacour/warden-core/types";
import type { DevtoolsFacet } from "@delacour/warden-e2e/devtools/devtools.types";
import { stubFacet } from "@delacour/warden-e2e/devtools/facet.testing";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { createUiCommand } from "../commands/ui";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import {
	BENCH_TARGETS,
	BENCH_TOLERANCE,
	type BenchMetric,
	type BenchResult,
	benchPassed,
	percentile,
	renderBenchTable,
	summarize,
} from "./bench";
import type { DevtoolsDeps } from "./devtools-cli";
import type { UiDeps } from "./driver";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const SERIAL = "emulator-5554";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("percentile", () => {
	test("nearest rank", () => {
		const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		expect(percentile(sorted, 0.5)).toBe(50);
		expect(percentile(sorted, 0.95)).toBe(100);
		expect(percentile([7], 0.5)).toBe(7);
		expect(percentile([7], 0.95)).toBe(7);
		expect(percentile([], 0.5)).toBeNaN();
	});
});

describe("summarize", () => {
	test("sorts, rounds to 0.1 ms and judges p50 against target x1.5", () => {
		const metric = summarize([50.04, 40, 90, 45, 55], { p50Ms: 40 });
		expect(metric).toEqual({ p50: 50, p95: 90, samples: 5, targetMs: 40, ok: true });
		const slow = summarize([61, 62, 63], { p50Ms: 40 });
		expect("ok" in slow && slow.ok).toBe(false);
	});

	test("a p95 target is checked too", () => {
		const target = BENCH_TARGETS.ios.snapshotWarm;
		if (!target) throw new Error("snapshotWarm target missing");
		const fine = summarize([50, 50, 50, 50, 170], target);
		expect(fine).toMatchObject({ p50: 50, p95: 170, targetMs: 60, targetP95Ms: 120, ok: true });
		const spiky = summarize([50, 50, 50, 50, 181], target);
		expect(spiky).toMatchObject({ p95: 181, ok: false });
	});

	test("no target: no ok", () => {
		expect(summarize([1, 2, 3], undefined)).toEqual({ p50: 2, p95: 3, samples: 3 });
	});
});

describe("targets", () => {
	test("the plan's table", () => {
		expect(BENCH_TOLERANCE).toBe(1.5);
		expect(BENCH_TARGETS.ios).toEqual({
			helperColdToSnapshot: { p50Ms: 1500 },
			snapshotWarm: { p50Ms: 60, p95Ms: 120 },
			pressHid: { p50Ms: 30 },
			pressSettle: { p50Ms: 600 },
			tree: { p50Ms: 250 },
			openDriver: { p50Ms: 500 },
		});
		expect(BENCH_TARGETS.android).toEqual({ snapshotWarm: { p50Ms: 800 }, pressHid: { p50Ms: 120 } });
	});
});

describe("renderBenchTable and benchPassed", () => {
	const result: BenchResult = {
		snapshotWarm: { p50: 55.5, p95: 100, samples: 20, targetMs: 60, targetP95Ms: 120, ok: true },
		pressHid: { p50: 40, p95: 44, samples: 20, targetMs: 30, ok: true },
		pressSettle: { p50: 1000, p95: 1100, samples: 5, targetMs: 600, ok: false },
		tree: { skipped: "devtools_unavailable", samples: 0, targetMs: 250 },
	};

	test("golden", () => {
		expect(renderBenchTable(result)).toBe(
			[
				"metric           p50     p95   n    target  status",
				"snapshotWarm    55.5   100.0  20  <60/<120  ok",
				"pressHid        40.0    44.0  20       <30  slow",
				"pressSettle   1000.0  1100.0   5      <600  FAIL",
				"tree               -       -   0      <250  skip (devtools_unavailable)",
			].join("\n")
		);
	});

	test("skipped metrics never fail the run, an over-tolerance one does", () => {
		expect(benchPassed(result)).toBe(false);
		const { pressSettle: _slow, ...rest } = result;
		expect(benchPassed(rest)).toBe(true);
	});
});

type Harness = {
	c: TestContext;
	clock: { t: number };
	run: (...argv: string[]) => Promise<number>;
	json: () => { ok: boolean; result: { runs: number; passed: boolean; metrics: Record<string, BenchMetric> } };
	stops: string[];
	seconds: number;
	calls: () => string[];
};

/** Milliseconds each fake call "takes": the injected clock moves by this much. */
const COST = { snapshot: 50, tap: 20, cold: 900, tree: 120, second: 200 } as const;

function harness(options: { platform?: Platform; withMetro?: boolean } = {}): Harness {
	const platform = options.platform ?? "ios";
	const udid = platform === "ios" ? UDID : SERIAL;
	const clock = { t: 1_000_000 };
	const driver = fakeDriver({
		platform,
		screens: [snapshotOf([el("window", { children: [el("button", { label: "Go", id: "go" })] })])],
		onCall: (call) => {
			if (call.method === "snapshot") clock.t += COST.snapshot;
			if (call.method === "tap") clock.t += COST.tap;
			return undefined;
		},
	});
	const stub = stubFacet();
	const facet: DevtoolsFacet = {
		...stub.facet,
		tree: async (treeOptions) => {
			clock.t += COST.tree;
			return stub.facet.tree(treeOptions);
		},
	};
	const devtools: DevtoolsDeps = {
		open: async () => ok(facet),
		probe: async () => "none",
		collector: {
			self: () => [],
			spawnDetached: () => ({ pid: 1 }),
			kill: () => undefined,
			pidAlive: () => false,
		},
	};
	const stops: string[] = [];
	const state = { seconds: 0 };
	const deps: UiDeps = {
		driver: async () => {
			clock.t += COST.cold;
			return ok(driver);
		},
		sleep: async (ms) => {
			clock.t += ms;
		},
		devtools,
		bench: {
			clock: () => clock.t,
			stopHelper: async (_ctx, id) => {
				stops.push(id);
			},
			openSecond: async () => {
				state.seconds += 1;
				clock.t += COST.second;
				return ok(driver);
			},
		},
	};
	const c = testContext([], { now: () => clock.t });
	ctx = c;
	c.env = {
		...c.env,
		...OWNER_ENV,
		...(options.withMetro === false ? {} : { WARDEN_METRO_URL: "http://127.0.0.1:8081" }),
	};
	c.db.insertLease(
		{
			resource: { kind: "device", platform, id: udid, name: "dev" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		clock.t
	);
	const command = createUiCommand(deps);
	return {
		c,
		clock,
		stops,
		get seconds() {
			return state.seconds;
		},
		calls: () => driver.calls.map((call) => call.method),
		run: (...argv) => {
			c.argv = [...argv, "--udid", udid];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
		json: () => JSON.parse(c.stdout[0] ?? ""),
	};
}

describe("warden ui bench (ios)", () => {
	test("--json: every metric with percentiles, sample counts, targets and ok", async () => {
		const h = harness();
		expect(await h.run("bench", "--runs", "10", "--json")).toBe(0);
		const doc = h.json();
		expect(doc.ok).toBe(true);
		expect(doc.result.runs).toBe(10);
		expect(doc.result.passed).toBe(true);
		const { metrics } = doc.result;
		expect(Object.keys(metrics).sort()).toEqual(
			["helperColdToSnapshot", "openDriver", "pressHid", "pressSettle", "snapshotWarm", "tree"].sort()
		);
		expect(metrics.helperColdToSnapshot).toEqual({
			p50: COST.cold + COST.snapshot,
			p95: COST.cold + COST.snapshot,
			samples: 3,
			targetMs: 1500,
			ok: true,
		});
		expect(metrics.snapshotWarm).toEqual({
			p50: 50,
			p95: 50,
			samples: 10,
			targetMs: 60,
			targetP95Ms: 120,
			ok: true,
		});
		expect(metrics.pressHid).toEqual({ p50: 20, p95: 20, samples: 10, targetMs: 30, ok: true });
		expect(metrics.tree).toEqual({ p50: COST.tree, p95: COST.tree, samples: 10, targetMs: 250, ok: true });
		expect(metrics.openDriver).toEqual({
			p50: COST.second,
			p95: COST.second,
			samples: 5,
			targetMs: 500,
			ok: true,
		});
		expect(metrics.pressSettle).toMatchObject({ samples: 5, targetMs: 600 });
	});

	test("the helper is stopped before every cold sample, and the second driver opens once per sample", async () => {
		const h = harness();
		await h.run("bench", "--runs", "4", "--json");
		expect(h.stops).toEqual([UDID, UDID, UDID]);
		expect(h.seconds).toBe(4);
	});

	test("without a dev client the tree metric is skipped, not failed", async () => {
		const h = harness({ withMetro: false });
		expect(await h.run("bench", "--runs", "3", "--json")).toBe(0);
		const doc = h.json();
		expect(doc.result.passed).toBe(true);
		expect(doc.result.metrics.tree).toMatchObject({ skipped: "devtools_unavailable", samples: 0, targetMs: 250 });
		expect(doc.result.metrics.snapshotWarm).toBeDefined();
	});

	test("over target x1.5: ok false, passed false, exit still 0, warning names the metric", async () => {
		const h = harness();
		const slow = fakeDriver({
			screens: [snapshotOf([el("window")])],
			onCall: (call) => {
				if (call.method === "snapshot") h.clock.t += 200;
				return undefined;
			},
		});
		const deps: UiDeps = {
			driver: async () => ok(slow),
			sleep: async (ms) => {
				h.clock.t += ms;
			},
			bench: { clock: () => h.clock.t, stopHelper: async () => undefined, openSecond: async () => ok(slow) },
			devtools: undefined,
		};
		const command = createUiCommand(deps);
		h.c.argv = ["bench", "--runs", "3", "--json", "--udid", UDID];
		h.c.stdout.length = 0;
		expect(await command.run(h.c)).toBe(0);
		const doc = h.json();
		expect(doc.result.passed).toBe(false);
		expect(doc.result.metrics.snapshotWarm).toMatchObject({ p50: 200, ok: false });
	});

	test("text output is the table", async () => {
		const h = harness();
		expect(await h.run("bench", "--runs", "3")).toBe(0);
		const out = h.c.stdout.join("\n");
		expect(out).toContain("metric");
		expect(out).toMatch(/snapshotWarm\s+50\.0\s+50\.0\s+3\s+<60\/<120\s+ok/);
		expect(out).toMatch(/pressHid\s+20\.0/);
	});

	test("--runs must be a positive integer", async () => {
		const h = harness();
		expect(await h.run("bench", "--runs", "0", "--json")).toBe(1);
		expect(JSON.parse(h.c.stdout[0] ?? "")).toMatchObject({ ok: false, error: { code: "usage" } });
	});

	test("taps the middle of the screen", async () => {
		const h = harness();
		await h.run("bench", "--runs", "1", "--json");
		expect(h.calls()).toContain("tap");
	});
});

describe("warden ui bench (android)", () => {
	test("only snapshotWarm and pressHid, with the android targets", async () => {
		const h = harness({ platform: "android" });
		expect(await h.run("bench", "--runs", "6", "--json")).toBe(0);
		const { metrics } = h.json().result;
		expect(Object.keys(metrics).sort()).toEqual(["pressHid", "snapshotWarm"]);
		expect(metrics.snapshotWarm).toEqual({ p50: 50, p95: 50, samples: 6, targetMs: 800, ok: true });
		expect(metrics.pressHid).toEqual({ p50: 20, p95: 20, samples: 6, targetMs: 120, ok: true });
		expect(h.stops).toEqual([]);
	});
});
