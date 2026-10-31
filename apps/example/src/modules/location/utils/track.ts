import type { LogLine } from "@/modules/showcase/components/event-log";
import type { Tone } from "@/modules/showcase/utils/tones";
import { distanceMeters, formatDistance, formatSpeed, GEOFENCE_RADIUS_M, type LatLon } from "./geo";

export type PermissionState = "undetermined" | "granted" | "denied";

/** One GPS fix as the screen reads it; `speed` is `coords.speed` (negative or null when the OS has none). */
export type TrackFix = LatLon & { timestamp: number; speed: number | null };

export type TrackState = {
	permission: PermissionState;
	tracking: boolean;
	/** First fix of the session: the geofence is centred here and distances are measured from it. */
	origin: LatLon | null;
	/** The drawn polyline, oldest first, capped at {@link MAX_TRACK}. */
	track: readonly LatLon[];
	/** Fixes received since the last clear (not capped). */
	count: number;
	last: TrackFix | null;
	speed: number | null;
	inside: boolean | null;
	/** Newest first, capped at {@link MAX_EVENTS}. */
	events: readonly LogLine[];
};

export type TrackAction =
	| { type: "permission"; permission: PermissionState; at: number }
	| { type: "started"; at: number }
	| { type: "cleared"; at: number }
	| { type: "fix"; fix: TrackFix; at: number };

export const MAX_EVENTS = 6;
export const MAX_TRACK = 600;
/** Below this the device counts as holding still. */
export const STILL_SPEED_MPS = 0.5;

export const initialTrack: TrackState = {
	permission: "undetermined",
	tracking: false,
	origin: null,
	track: [],
	count: 0,
	last: null,
	speed: null,
	inside: null,
	events: [],
};

/** The fix's own speed when it has one (>= 0), else distance over time since `previous`; null when neither exists. */
export function speedOf(fix: TrackFix, previous: TrackFix | null): number | null {
	if (fix.speed !== null && fix.speed >= 0) return fix.speed;
	if (previous === null) return null;
	const seconds = (fix.timestamp - previous.timestamp) / 1000;
	return seconds > 0 ? distanceMeters(previous, fix) / seconds : null;
}

const withEvents = (state: TrackState, ...lines: LogLine[]): readonly LogLine[] =>
	[...lines, ...state.events].slice(0, MAX_EVENTS);

/** Folds one GPS fix into the track: origin, count, speed, geofence verdict and the log lines it earns. */
function applyFix(state: TrackState, fix: TrackFix, at: number): TrackState {
	const point: LatLon = { lat: fix.lat, lon: fix.lon };
	const origin = state.origin ?? point;
	const speed = speedOf(fix, state.last);
	const count = state.count + 1;
	const inside = distanceMeters(origin, point) <= GEOFENCE_RADIUS_M;
	const lines: LogLine[] = [{ at, text: `fix #${count} · ${formatSpeed(speed)}`, tone: "scan" }];
	if (state.inside !== null && state.inside !== inside) {
		lines.unshift(
			inside ? { at, text: "entered geofence", tone: "open" } : { at, text: "left geofence", tone: "warn" }
		);
	}
	const track = [...state.track, point];
	return {
		...state,
		origin,
		track: track.length > MAX_TRACK ? track.slice(track.length - MAX_TRACK) : track,
		count,
		last: fix,
		speed,
		inside,
		events: withEvents(state, ...lines),
	};
}

/** The track, the geofence verdict and the log, advanced by one action. Pure: callers pass the clock in as `at`. */
export function trackReducer(state: TrackState, action: TrackAction): TrackState {
	switch (action.type) {
		case "permission": {
			if (action.permission === state.permission) return state;
			if (action.permission === "denied") {
				return {
					...state,
					permission: "denied",
					tracking: false,
					events: withEvents(state, { at: action.at, text: "permission denied", tone: "warn" }),
				};
			}
			return { ...state, permission: action.permission };
		}
		case "started":
			if (state.tracking) return state;
			return {
				...state,
				tracking: true,
				events: withEvents(state, { at: action.at, text: "tracking started", tone: "idle" }),
			};
		case "cleared":
			return {
				...state,
				origin: null,
				track: [],
				count: 0,
				last: null,
				speed: null,
				inside: null,
				events: withEvents(state, { at: action.at, text: "track cleared", tone: "idle" }),
			};
		case "fix":
			return applyFix(state, action.fix, action.at);
	}
}

/** The headline, one supporting line, and the tone both the glyph and the navbar icon take. */
export type TrackDescription = { title: string; body: string; tone: Tone };

/** What the screen says about the state: one headline (its leading word is what specs match) and one line. */
export function describeTrack(state: TrackState): TrackDescription {
	if (state.permission === "denied") {
		return { title: "Permission denied", body: "Location access is off for this app.", tone: "warn" };
	}
	if (!state.tracking) {
		return { title: "Not tracking", body: "Start tracking to read live GPS fixes.", tone: "off" };
	}
	if (state.last === null || state.origin === null || state.inside === null) {
		return { title: "No fix yet", body: "Waiting for the first GPS fix.", tone: "scan" };
	}
	const distance = distanceMeters(state.origin, state.last);
	const tone: Tone = state.inside ? "open" : "warn";
	const moving = state.speed !== null && state.speed >= STILL_SPEED_MPS;
	const where = `${formatDistance(distance)} from the start, ${state.inside ? "inside" : "outside"} the geofence.`;
	if (moving) {
		return { title: `Moving · ${Math.round(state.speed ?? 0)} m/s`, body: where, tone };
	}
	return {
		title: "Holding still",
		body: state.inside ? `Inside the ${GEOFENCE_RADIUS_M} m geofence.` : where,
		tone,
	};
}
