import { describe, expect, test } from "bun:test";
import { loadGpxPoints, planRoute } from "./location-plan";
import { ANDROID_SCENARIOS } from "./location-scenarios.data";

const GPX = `<gpx><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></gpx>`;
const read = async (path: string): Promise<string> => {
	if (path === "/a.gpx") return GPX;
	throw new Error(`ENOENT ${path}`);
};

describe("loadGpxPoints", () => {
	test("reads and parses", async () => {
		expect(await loadGpxPoints("/a.gpx", read)).toEqual({
			success: true,
			data: [
				{ lat: 1, lon: 2 },
				{ lat: 3, lon: 4 },
			],
		});
	});
	test("unreadable file and empty gpx are errors naming the path", async () => {
		const missing = await loadGpxPoints("/nope.gpx", read);
		expect(!missing.success && missing.error).toContain("/nope.gpx");
		const empty = await loadGpxPoints("/e.gpx", async () => "<gpx/>");
		expect(!empty.success && empty.error).toContain("/e.gpx");
	});
});

describe("planRoute", () => {
	test("route fills the defaults", async () => {
		const points = [
			{ lat: 0, lon: 0 },
			{ lat: 0, lon: 1 },
		];
		expect(await planRoute({ kind: "route", points }, read)).toEqual({
			success: true,
			data: { points, speedMps: 20, intervalS: 1, loop: false },
		});
	});
	test("gpx uses its file and speed", async () => {
		const plan = await planRoute({ kind: "gpx", path: "/a.gpx", speedMps: 5 }, read);
		expect(plan.success && plan.data.speedMps).toBe(5);
		expect(plan.success && plan.data.points.length).toBe(2);
	});
	test("scenario uses the bundled waypoint set", async () => {
		const plan = await planRoute({ kind: "scenario", name: "freeway" }, read);
		expect(plan.success && plan.data.points).toEqual(ANDROID_SCENARIOS.freeway.points);
		expect(plan.success && plan.data.speedMps).toBe(ANDROID_SCENARIOS.freeway.speedMps);
	});
	test("an empty route is an error", async () => {
		expect((await planRoute({ kind: "route", points: [] }, read)).success).toBe(false);
	});
});
