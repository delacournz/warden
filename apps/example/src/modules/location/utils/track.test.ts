import { describe, expect, test } from "bun:test";
import {
	describeTrack,
	initialTrack,
	MAX_EVENTS,
	speedOf,
	type TrackAction,
	type TrackState,
	trackReducer,
} from "./track";

const A = { lat: 37.3349, lon: -122.009 };
/** About `m` metres north of A. */
const north = (m: number) => ({ lat: A.lat + m / 111_195, lon: A.lon });
const fix = (p: { lat: number; lon: number }, timestamp: number, speed: number | null = null) => ({
	...p,
	timestamp,
	speed,
});

function run(actions: TrackAction[], from: TrackState = initialTrack): TrackState {
	return actions.reduce(trackReducer, from);
}

describe("speedOf", () => {
	test("uses the reported speed when it is >= 0", () => {
		expect(speedOf(fix(A, 2000, 12), fix(A, 1000))).toBe(12);
		expect(speedOf(fix(A, 2000, 0), null)).toBe(0);
	});
	test("a negative or missing speed falls back to distance / time", () => {
		const s = speedOf(fix(north(250), 11_000, -1), fix(A, 1000));
		expect(s).toBeCloseTo(25, 0);
	});
	test("unknown with no previous fix or no elapsed time", () => {
		expect(speedOf(fix(A, 1000, -1), null)).toBeNull();
		expect(speedOf(fix(north(10), 1000, null), fix(A, 1000))).toBeNull();
	});
});

describe("trackReducer", () => {
	test("starts undetermined and idle", () => {
		expect(initialTrack.tracking).toBe(false);
		expect(initialTrack.count).toBe(0);
		expect(initialTrack.permission).toBe("undetermined");
	});
	test("a denied permission logs once and stops tracking", () => {
		const s = run([{ type: "permission", permission: "denied", at: 5 }]);
		expect(s.permission).toBe("denied");
		expect(s.tracking).toBe(false);
		expect(s.events).toEqual([{ at: 5, text: "permission denied", tone: "warn" }]);
	});
	test("started logs tracking started", () => {
		const s = run([
			{ type: "permission", permission: "granted", at: 1 },
			{ type: "started", at: 2 },
		]);
		expect(s.tracking).toBe(true);
		expect(s.events[0]).toEqual({ at: 2, text: "tracking started", tone: "idle" });
	});
	test("the first fix sets the origin, counts, and is inside", () => {
		const s = run([
			{ type: "started", at: 0 },
			{ type: "fix", fix: fix(A, 1000, -1), at: 10 },
		]);
		expect(s.origin).toEqual(A);
		expect(s.count).toBe(1);
		expect(s.inside).toBe(true);
		expect(s.speed).toBeNull();
		expect(s.track).toEqual([A]);
		expect(s.events[0].text).toBe("fix #1 · -");
		expect(s.events.some((e) => e.text.includes("geofence"))).toBe(false);
	});
	test("leaving logs once, newest first", () => {
		const s = run([
			{ type: "started", at: 0 },
			{ type: "fix", fix: fix(A, 1000, 0), at: 10 },
			{ type: "fix", fix: fix(north(400), 2000, 25), at: 20 },
		]);
		expect(s.inside).toBe(false);
		expect(s.events[0]).toEqual({ at: 20, text: "left geofence", tone: "warn" });
		expect(s.events[1].text).toBe("fix #2 · 25.0 m/s");
	});
	test("returning logs entered once, and staying outside logs nothing more", () => {
		const s = run([
			{ type: "started", at: 0 },
			{ type: "fix", fix: fix(A, 1000, 0), at: 10 },
			{ type: "fix", fix: fix(north(400), 2000, 25), at: 20 },
			{ type: "fix", fix: fix(north(500), 3000, 25), at: 30 },
			{ type: "fix", fix: fix(north(40), 4000, 25), at: 40 },
		]);
		expect(s.inside).toBe(true);
		expect(s.events[0]).toEqual({ at: 40, text: "entered geofence", tone: "open" });
		const left = run([
			{ type: "started", at: 0 },
			{ type: "fix", fix: fix(A, 1000, 0), at: 10 },
			{ type: "fix", fix: fix(north(400), 2000, 25), at: 20 },
			{ type: "fix", fix: fix(north(500), 3000, 25), at: 30 },
		]);
		expect(left.events.filter((e) => e.text === "left geofence")).toHaveLength(1);
	});
	test("events keep the newest MAX_EVENTS", () => {
		let s = run([{ type: "started", at: 0 }]);
		for (let i = 0; i < 20; i++) s = trackReducer(s, { type: "fix", fix: fix(A, 1000 + i * 1000, 0), at: 10 + i });
		expect(s.events).toHaveLength(MAX_EVENTS);
		expect(s.events[0].text).toBe("fix #20 · 0.0 m/s");
	});
	test("the drawn track is capped but the count is not", () => {
		let s = run([{ type: "started", at: 0 }]);
		for (let i = 0; i < 700; i++) s = trackReducer(s, { type: "fix", fix: fix(north(i), 1000 + i * 1000, 1), at: i });
		expect(s.count).toBe(700);
		expect(s.track.length).toBeLessThanOrEqual(600);
		expect(s.track.at(-1)).toEqual(north(699));
	});
	test("cleared keeps tracking, drops the track, and the next fix becomes the origin", () => {
		let s = run([
			{ type: "started", at: 0 },
			{ type: "fix", fix: fix(A, 1000, 0), at: 10 },
			{ type: "fix", fix: fix(north(400), 2000, 25), at: 20 },
			{ type: "cleared", at: 30 },
		]);
		expect(s.tracking).toBe(true);
		expect(s.count).toBe(0);
		expect(s.track).toEqual([]);
		expect(s.origin).toBeNull();
		expect(s.inside).toBeNull();
		expect(s.events[0].text).toBe("track cleared");
		s = trackReducer(s, { type: "fix", fix: fix(north(400), 3000, 0), at: 40 });
		expect(s.origin).toEqual(north(400));
		expect(s.inside).toBe(true);
	});
});

describe("describeTrack", () => {
	const started = (more: TrackAction[] = []) =>
		run([{ type: "permission", permission: "granted", at: 0 }, { type: "started", at: 1 }, ...more]);

	test("Not tracking before the first start", () => {
		const d = describeTrack(initialTrack);
		expect(d.title).toBe("Not tracking");
		expect(d.tone).toBe("off");
	});
	test("Permission denied wins", () => {
		const d = describeTrack(run([{ type: "permission", permission: "denied", at: 0 }]));
		expect(d.title).toBe("Permission denied");
		expect(d.tone).toBe("warn");
	});
	test("No fix yet while waiting", () => {
		const d = describeTrack(started());
		expect(d.title).toBe("No fix yet");
		expect(d.body).toBe("Waiting for the first GPS fix.");
		expect(d.tone).toBe("scan");
	});
	test("Holding still when slow, inside", () => {
		const d = describeTrack(started([{ type: "fix", fix: fix(A, 1000, 0.1), at: 5 }]));
		expect(d.title).toBe("Holding still");
		expect(d.body).toBe("Inside the 150 m geofence.");
		expect(d.tone).toBe("open");
	});
	test("a single fix with unknown speed counts as holding still", () => {
		expect(describeTrack(started([{ type: "fix", fix: fix(A, 1000, -1), at: 5 }])).title).toBe("Holding still");
	});
	test("Moving carries the speed and says how far, outside", () => {
		const d = describeTrack(
			started([
				{ type: "fix", fix: fix(A, 1000, 0), at: 5 },
				{ type: "fix", fix: fix(north(1243), 2000, 25), at: 6 },
			])
		);
		expect(d.title).toBe("Moving · 25 m/s");
		expect(d.body).toBe("1.24 km from the start, outside the geofence.");
		expect(d.tone).toBe("warn");
	});
	test("moving inside the geofence is open and says inside", () => {
		const d = describeTrack(
			started([
				{ type: "fix", fix: fix(A, 1000, 0), at: 5 },
				{ type: "fix", fix: fix(north(60), 2000, 5), at: 6 },
			])
		);
		expect(d.title).toBe("Moving · 5 m/s");
		expect(d.body).toBe("60 m from the start, inside the geofence.");
		expect(d.tone).toBe("open");
	});
	test("holding still outside the geofence says how far", () => {
		const d = describeTrack(
			started([
				{ type: "fix", fix: fix(A, 1000, 0), at: 5 },
				{ type: "fix", fix: fix(north(400), 2000, 0), at: 6 },
			])
		);
		expect(d.title).toBe("Holding still");
		expect(d.body).toBe("400 m from the start, outside the geofence.");
	});
});
