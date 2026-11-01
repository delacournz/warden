import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecCall, fakeExec, joined } from "./exec.testing";
import {
	createSimctl,
	LOCATION_ARGV_MAX_POINTS,
	locationClearArgv,
	locationRunArgv,
	locationSetArgv,
	locationStartArgv,
} from "./simctl";

const UDID = "UDID-1";
const A = { lat: 37.3318, lon: -122.0312 };
const B = { lat: 37.3349, lon: -122.009 };

function harness() {
	const calls: ExecCall[] = [];
	const simctl = createSimctl({ udid: UDID, exec: fakeExec([["", {}]], calls), env: {}, devicesRoot: "/d" });
	return { simctl, calls };
}

describe("location argv", () => {
	test("set is lat,lon", () => {
		expect(locationSetArgv(UDID, A)).toEqual(["xcrun", "simctl", "location", UDID, "set", "37.3318,-122.0312"]);
	});
	test("clear and run", () => {
		expect(locationClearArgv(UDID)).toEqual(["xcrun", "simctl", "location", UDID, "clear"]);
		expect(locationRunArgv(UDID, "City Run")).toEqual(["xcrun", "simctl", "location", UDID, "run", "City Run"]);
	});
	test("start carries speed and interval flags before the waypoints", () => {
		expect(locationStartArgv(UDID, [A, B], { speedMps: 3, intervalS: 2 })).toEqual([
			"xcrun",
			"simctl",
			"location",
			UDID,
			"start",
			"--speed=3",
			"--interval=2",
			"37.3318,-122.0312",
			"37.3349,-122.009",
		]);
		expect(locationStartArgv(UDID, [A, B]).slice(4)).toEqual(["start", "37.3318,-122.0312", "37.3349,-122.009"]);
	});
	test("a long route goes through stdin with the - operand", () => {
		const points = Array.from({ length: LOCATION_ARGV_MAX_POINTS + 1 }, (_, i) => ({ lat: i / 1000, lon: 1 }));
		const argv = locationStartArgv(UDID, points, { speedMps: 5 });
		expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(argv[2]).toContain("start $3 -");
		expect(argv[4]?.split("\n")).toHaveLength(points.length);
		expect(argv.slice(5)).toEqual([UDID, "--speed=5"]);
	});
});

describe("simctl.location", () => {
	test("point, clear and scenario map to Apple's names", async () => {
		const h = harness();
		await h.simctl.location({ kind: "point", ...A });
		await h.simctl.location({ kind: "clear" });
		await h.simctl.location({ kind: "scenario", name: "city-bike" });
		await h.simctl.location({ kind: "scenario", name: "freeway" });
		expect(joined(h.calls)).toEqual([
			`xcrun simctl location ${UDID} set 37.3318,-122.0312`,
			`xcrun simctl location ${UDID} clear`,
			`xcrun simctl location ${UDID} run City Bicycle Ride`,
			`xcrun simctl location ${UDID} run Freeway Drive`,
		]);
	});

	test("route starts with its pace; one point is just a set", async () => {
		const h = harness();
		await h.simctl.location({ kind: "route", points: [A, B], speedMps: 4, intervalS: 1 });
		await h.simctl.location({ kind: "route", points: [A] });
		expect(joined(h.calls)).toEqual([
			`xcrun simctl location ${UDID} start --speed=4 --interval=1 37.3318,-122.0312 37.3349,-122.009`,
			`xcrun simctl location ${UDID} set 37.3318,-122.0312`,
		]);
	});

	test("loop and empty routes are refused without running anything", async () => {
		const h = harness();
		const looped = await h.simctl.location({ kind: "route", points: [A, B], loop: true });
		expect(!looped.success && looped.error.code).toBe("E_UNSUPPORTED");
		const empty = await h.simctl.location({ kind: "route", points: [] });
		expect(!empty.success && empty.error.code).toBe("E_BAD_REQUEST");
		expect(h.calls).toHaveLength(0);
	});

	test("gpx is read from disk and played", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wdn-gpx-"));
		const file = join(dir, "r.gpx");
		writeFileSync(file, `<gpx><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></gpx>`);
		const h = harness();
		const res = await h.simctl.location({ kind: "gpx", path: file, speedMps: 10 });
		expect(res.success).toBe(true);
		expect(joined(h.calls)).toEqual([`xcrun simctl location ${UDID} start --speed=10 1,2 3,4`]);
		const bad = await h.simctl.location({ kind: "gpx", path: join(dir, "missing.gpx") });
		expect(!bad.success && bad.error.code).toBe("E_BAD_REQUEST");
	});

	test("a failing simctl is the error", async () => {
		const simctl = createSimctl({
			udid: UDID,
			exec: fakeExec([["", { exitCode: 1, stderr: "Invalid device" }]]),
			env: {},
			devicesRoot: "/d",
		});
		expect((await simctl.location({ kind: "clear" })).success).toBe(false);
	});
});
