import { describe, expect, test } from "bun:test";
import type { LatLon } from "@delacour/warden-config/conditions.types";
import { geoMath } from "./geo";
import { routeTickers, type TickerClock } from "./route-ticker";

const A: LatLon = { lat: 0, lon: 0 };
const B: LatLon = { lat: 0, lon: 0.001 };

/** Virtual time: `sleep` advances `t`, resolves immediately, and honours the abort signal. */
function fakeClock(): TickerClock & { t: number; sleeps: number[] } {
	const clock = {
		t: 0,
		sleeps: [] as number[],
		now: () => clock.t,
		sleep: async (ms: number, signal: AbortSignal) => {
			if (signal.aborted) return;
			clock.sleeps.push(ms);
			clock.t += ms;
		},
	};
	return clock;
}

describe("routeTickers.start", () => {
	test("plays every step once and finishes", async () => {
		const clock = fakeClock();
		const fixes: LatLon[] = [];
		const ticker = routeTickers.start(
			{ points: [A, B], speedMps: 20, intervalS: 1 },
			{ fix: async (p) => void fixes.push(p), ...clock }
		);
		const outcome = await ticker.done;
		expect(fixes).toEqual(geoMath.routeSteps([A, B], 20, 1));
		expect(outcome).toEqual({ ticks: fixes.length, stopped: "finished" });
	});

	test("paces by intervalS against the clock, not by accumulated sleeps", async () => {
		const clock = fakeClock();
		let n = 0;
		const ticker = routeTickers.start(
			{ points: [A, B], speedMps: 20, intervalS: 2 },
			{
				fix: async () => {
					n++;
					clock.t += 150;
					return undefined;
				},
				...clock,
			}
		);
		await ticker.done;
		expect(clock.sleeps.every((ms) => ms === 1850)).toBe(true);
		expect(n).toBeGreaterThan(2);
	});

	test("loop repeats until stopped", async () => {
		const clock = fakeClock();
		const fixes: LatLon[] = [];
		const per = geoMath.routeSteps([A, B], 20, 1).length;
		const ticker = routeTickers.start(
			{ points: [A, B], speedMps: 20, intervalS: 1, loop: true },
			{
				fix: async (p) => {
					fixes.push(p);
					if (fixes.length === per * 3) ticker.stop();
					return undefined;
				},
				...clock,
			}
		);
		const outcome = await ticker.done;
		expect(outcome.stopped).toBe("aborted");
		expect(fixes.length).toBe(per * 3);
	});

	test("stop is idempotent and halts before the next fix", async () => {
		const clock = fakeClock();
		const fixes: LatLon[] = [];
		const ticker = routeTickers.start({ points: [A, B] }, { fix: async (p) => void fixes.push(p), ...clock });
		ticker.stop();
		ticker.stop();
		const outcome = await ticker.done;
		expect(outcome.stopped).toBe("aborted");
		expect(fixes.length).toBeLessThanOrEqual(1);
	});

	test("three failed fixes in a row end it with the error", async () => {
		const clock = fakeClock();
		let calls = 0;
		const ticker = routeTickers.start(
			{ points: [A, B], speedMps: 1, intervalS: 1 },
			{
				fix: async () => {
					calls++;
					return "KO: no console";
				},
				...clock,
			}
		);
		const outcome = await ticker.done;
		expect(calls).toBe(3);
		expect(outcome).toEqual({ ticks: 0, stopped: "failed", error: "KO: no console" });
	});

	test("a good fix resets the failure count", async () => {
		const clock = fakeClock();
		let calls = 0;
		const ticker = routeTickers.start(
			{ points: [A, B], speedMps: 5, intervalS: 1 },
			{
				fix: async () => {
					calls++;
					return calls === 3 ? undefined : "KO";
				},
				...clock,
			}
		);
		const outcome = await ticker.done;
		expect(outcome.stopped).toBe("failed");
		expect(calls).toBeGreaterThan(3);
	});

	test("defaults to 20 m/s every second", async () => {
		const clock = fakeClock();
		const fixes: LatLon[] = [];
		await routeTickers.start({ points: [A, B] }, { fix: async (p) => void fixes.push(p), ...clock }).done;
		expect(fixes).toEqual(geoMath.routeSteps([A, B], 20, 1));
	});
});

describe("routeTickers.parseConfig / routeTickers.detachedArgv", () => {
	const config = { adb: "/sdk/adb", serial: "emulator-5554", points: [A, B], speedMps: 3, intervalS: 2, loop: true };

	test("argv carries the config as one JSON argument that round-trips", () => {
		const argv = routeTickers.detachedArgv("/usr/bin/bun", "/x/route-ticker.main.ts", config);
		expect(argv.slice(0, 2)).toEqual(["/usr/bin/bun", "/x/route-ticker.main.ts"]);
		expect(argv).toHaveLength(3);
		expect(routeTickers.parseConfig(argv[2] as string)).toEqual({ success: true, data: config });
	});

	test("rejects junk", () => {
		expect(routeTickers.parseConfig("nope").success).toBe(false);
		expect(routeTickers.parseConfig(JSON.stringify({ adb: "a", serial: "s", points: [] })).success).toBe(false);
		expect(routeTickers.parseConfig(JSON.stringify({ adb: "a", points: [A] })).success).toBe(false);
		expect(routeTickers.parseConfig(JSON.stringify({ adb: "a", serial: "s", points: [{ lat: "x" }] })).success).toBe(
			false
		);
	});
});
