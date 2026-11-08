import { useCallback, useRef, useState } from "react";
import { useFrameCallback, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { INSTALLED_AT } from "@/modules/conditions/utils/trial";
import type { LogLine } from "@/modules/showcase/components/event-log";
import { eventsFor, pushEvents, type Sample } from "../utils/clock-events";
import { type TrialState, trialStateOf } from "../utils/trial-view";

/** How often the screen reads the clocks. */
const TICK_MS = 500;
/** A read closer than this to the last one is skipped (the frame loop and the first read can overlap). */
const MIN_GAP_MS = 400;

/**
 * Both clocks as this JS runtime first saw them. The trial start and the drift are measured from here, so a clock that
 * warden moves later shows up as a distance from a fixed point. `INSTALLED_AT` is the conditions screen's own rule for
 * the start (this launch's `Date.now()`), reused so both screens agree.
 */
const BASELINE: Sample = { wall: Date.now(), mono: performance.now() };
let trialStart = INSTALLED_AT;

export type TrialClock = {
	/** The device wall clock at the last read. */
	now: number;
	start: number;
	state: TrialState;
	/** How far the wall clock has moved beyond real time since the baseline. */
	offsetMs: number;
	/** Newest first. */
	events: readonly LogLine[];
	restart: () => void;
};

function read(): Sample {
	return { wall: Date.now(), mono: performance.now() };
}

/**
 * Reads the wall clock against the monotonic one twice a second and logs what changed: a jump, the trial expiring or
 * coming back. The reads run off Reanimated's frame loop and not a JS timer: React Native arms timers against the wall
 * clock, so one armed while warden's clock was ahead would sleep through a `clock reset` for as long as the jump.
 */
export function useTrialClock(): TrialClock {
	const opened = useRef(performance.now());
	const [sample, setSample] = useState<Sample>(() => read());
	const last = useRef(sample);
	const [start, setStart] = useState(trialStart);
	const startRef = useRef(start);
	const [events, setEvents] = useState<readonly LogLine[]>([{ at: 0, text: "trial started", tone: "idle" }]);

	const lastTickMs = useSharedValue(0);

	const tick = useCallback(() => {
		const next = read();
		const prev = last.current;
		if (next.mono - prev.mono < MIN_GAP_MS) return;
		last.current = next;
		const lines = eventsFor(prev, next, startRef.current, next.mono - opened.current);
		if (lines.length > 0) setEvents((log) => pushEvents(log, lines));
		setSample(next);
	}, []);

	const restart = useCallback(() => {
		const next = read();
		trialStart = next.wall;
		startRef.current = next.wall;
		last.current = next;
		setStart(next.wall);
		setSample(next);
		setEvents((log) => pushEvents(log, [{ at: next.mono - opened.current, text: "trial restarted", tone: "idle" }]));
	}, []);

	useFrameCallback((frame) => {
		"worklet";
		const elapsed = frame.timeSinceFirstFrame;
		if (elapsed - lastTickMs.value < TICK_MS) return;
		lastTickMs.value = elapsed;
		scheduleOnRN(tick);
	});

	return {
		now: sample.wall,
		start,
		state: trialStateOf(sample.wall, start),
		offsetMs: sample.wall - BASELINE.wall - (sample.mono - BASELINE.mono),
		events,
		restart,
	};
}
