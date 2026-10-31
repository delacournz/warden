import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LatLon } from "@delacour/warden-core/conditions/conditions.types";
import { routeSteps } from "../../conditions/geo";
import { ANDROID_SCENARIOS } from "../../conditions/location-scenarios.data";
import type { TickerClock } from "../../conditions/route-ticker";
import type { Driver } from "../driver.types";
import { openAndroidDriver } from "./android-driver";
import { fakeAndroidHost, type HostRule } from "./android-host.testing";

const open: Driver[] = [];
const A: LatLon = { lat: 37.3318, lon: -122.0312 };
const B: LatLon = { lat: 37.3349, lon: -122.009 };

/** A ticker clock whose sleeps wait on `release()` so a test can stop a route mid-way. */
function gatedClock() {
	let t = 0;
	let waiter: (() => void) | undefined;
	const clock: TickerClock = {
		now: () => t,
		sleep: (ms, signal) =>
			new Promise<void>((resolve) => {
				t += ms;
				if (signal.aborted) return resolve();
				waiter = resolve;
				signal.addEventListener("abort", () => resolve());
			}),
	};
	return { clock, release: () => waiter?.() };
}

async function setup(serial = "emulator-5554", host: HostRule[] = [], tickerClock?: TickerClock) {
	const fake = fakeAndroidHost({
		shell: [{ match: "getprop sys.boot_completed", reply: "1\n34\nPhysical size: 1080x2400\nPhysical density: 420\n" }],
		host,
	});
	let t = 0;
	const lines: string[] = [];
	const res = await openAndroidDriver({
		serial,
		adb: "adb",
		exec: fake.exec,
		spawn: fake.spawn,
		execBinary: fake.execBinary,
		log: (l) => lines.push(l),
		clock: {
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
		},
		screen: { width: 1080, height: 2400, scale: 2.625 },
		...(tickerClock ? { tickerClock } : {}),
	});
	if (!res.success) throw new Error(res.error.message);
	open.push(res.data);
	const fixes = () => fake.host.filter((a) => a.includes("geo"));
	return { driver: res.data, fake, fixes, lines };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((d) => d.close()));
});

describe("android location", () => {
	test("point sends longitude first, with altitude when given", async () => {
		const { driver, fixes } = await setup();
		expect((await driver.location({ kind: "point", ...A })).success).toBe(true);
		await driver.location({ kind: "point", lat: -36.85, lon: 174.76, altM: 20 });
		expect(fixes()).toEqual([
			["adb", "-s", "emulator-5554", "emu", "geo", "fix", "-122.0312", "37.3318"],
			["adb", "-s", "emulator-5554", "emu", "geo", "fix", "174.76", "-36.85", "20"],
		]);
	});

	test("the console's KO is an E_IO even when adb exits 0", async () => {
		const { driver } = await setup("emulator-5554", [{ match: /emu geo fix/, reply: "KO: no such command\n" }]);
		const res = await driver.location({ kind: "point", ...A });
		expect(!res.success && res.error.code).toBe("E_IO");
	});

	test("a physical device is E_UNSUPPORTED and runs nothing", async () => {
		const { driver, fixes } = await setup("R5CT12345");
		const res = await driver.location({ kind: "point", ...A });
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
		expect(fixes()).toEqual([]);
	});

	test("a route places the first fix, then ticks every step to the end", async () => {
		const instant: TickerClock = { now: () => 0, sleep: async () => undefined };
		const { driver, fixes } = await setup("emulator-5554", [], instant);
		const res = await driver.location({ kind: "route", points: [A, B], speedMps: 20, intervalS: 1 });
		expect(res.success).toBe(true);
		const expected = routeSteps([A, B], 20, 1).length + 1;
		for (let i = 0; i < 100 && fixes().length < expected; i++) await Bun.sleep(5);
		expect(fixes()).toHaveLength(expected);
		const last = fixes().at(-1);
		expect(last?.slice(6, 8)).toEqual([String(B.lon), String(B.lat)]);
	});

	test("the next op stops the running route", async () => {
		const gate = gatedClock();
		const { driver, fixes } = await setup("emulator-5554", [], gate.clock);
		await driver.location({ kind: "route", points: [A, B], speedMps: 1, intervalS: 1, loop: true });
		await Bun.sleep(20);
		const during = fixes().length;
		await driver.location({ kind: "point", lat: 1, lon: 2 });
		gate.release();
		await Bun.sleep(20);
		expect(fixes().length).toBe(during + 1);
		expect(fixes().at(-1)).toContain("2");
	});

	test("clear stops the ticker and sends no fix", async () => {
		const gate = gatedClock();
		const { driver, fixes } = await setup("emulator-5554", [], gate.clock);
		await driver.location({ kind: "route", points: [A, B], speedMps: 1, intervalS: 1, loop: true });
		await Bun.sleep(20);
		const during = fixes().length;
		expect((await driver.location({ kind: "clear" })).success).toBe(true);
		gate.release();
		await Bun.sleep(20);
		expect(fixes().length).toBe(during);
	});

	test("close stops the ticker", async () => {
		const gate = gatedClock();
		const { driver, fixes } = await setup("emulator-5554", [], gate.clock);
		await driver.location({ kind: "route", points: [A, B], speedMps: 1, intervalS: 1, loop: true });
		await Bun.sleep(20);
		await driver.close();
		const after = fixes().length;
		gate.release();
		await Bun.sleep(20);
		expect(fixes().length).toBe(after);
	});

	test("scenario starts at its first bundled waypoint; gpx at its first point", async () => {
		const gate = gatedClock();
		const { driver, fixes } = await setup("emulator-5554", [], gate.clock);
		await driver.location({ kind: "scenario", name: "freeway" });
		const first = ANDROID_SCENARIOS.freeway.points[0] as LatLon;
		expect(fixes()[0]?.slice(6, 8)).toEqual([String(first.lon), String(first.lat)]);
		const dir = mkdtempSync(join(tmpdir(), "wdn-gpx-"));
		const file = join(dir, "r.gpx");
		writeFileSync(file, `<gpx><trkpt lat="10" lon="20"/><trkpt lat="10.01" lon="20"/></gpx>`);
		await driver.location({ kind: "gpx", path: file });
		expect(fixes().at(-1)?.slice(6, 8)).toContain("20");
		const missing = await driver.location({ kind: "gpx", path: join(dir, "nope.gpx") });
		expect(!missing.success && missing.error.code).toBe("E_BAD_REQUEST");
	});
});
