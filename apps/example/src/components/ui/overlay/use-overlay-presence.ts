import { useCallback, useEffect, useRef, useState } from "react";
import {
	Easing,
	ReduceMotion,
	type SharedValue,
	useReducedMotion,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { OVERLAY_MOTION } from "./overlay.variants";
import {
	isCurrentFinish,
	isPresent,
	type PresenceEvent,
	type PresencePhase,
	presenceTarget,
	reducePresence,
} from "./overlay-presence";

export type UseOverlayPresenceOptions = {
	isOpen: boolean;
	/** Entrance duration, ms. Default `OVERLAY_MOTION.enterMs`. */
	enterMs?: number;
	/** Exit duration, ms. Default `OVERLAY_MOTION.exitMs`. */
	exitMs?: number;
	/** The entrance finished — the moment to move accessibility focus in. */
	onEntered?: () => void;
	/** The exit finished and the overlay is about to unmount. */
	onExited?: () => void;
};

export type OverlayPresence = {
	/** Keep the overlay mounted while true: from the open until the exit animation ends. */
	isPresent: boolean;
	/** 0 hidden → 1 shown, animated on the UI thread. Drive opacity and transforms from it. */
	progress: SharedValue<number>;
	/** Reduce motion is on: drop scales and translates, keep the fade. */
	isReduced: boolean;
	phase: PresencePhase;
};

const ENTER_EASING = Easing.out(Easing.cubic);
const EXIT_EASING = Easing.in(Easing.cubic);

/**
 * Keeps an overlay mounted through its exit animation and drives its
 * `progress` from 0 to 1 and back.
 *
 * `isOpen` is the owner's state; this follows it through `reducePresence`,
 * which is what lets a re-open during the exit reverse smoothly from wherever
 * the animation is. The finish of each animation reaches React through
 * `scheduleOnRN`, and only when the animation ran to the end — an interrupted
 * one reports nothing. A finish can still be queued when the owner flips
 * `isOpen`, so each animation carries its transition generation and
 * `isCurrentFinish` drops one that no longer matches the latest transition
 * and request, before it moves the phase or reaches `onEntered`/`onExited`.
 *
 * `onEntered` and `onExited` are read through refs, so an owner that passes
 * new inline callbacks on every render does not restart the timing.
 *
 * Under reduce motion the fade still runs — an opacity change is not motion —
 * so both timings set `ReduceMotion.Never`, and `isReduced` tells the
 * component to drop its transforms.
 */
export function useOverlayPresence({
	isOpen,
	enterMs = OVERLAY_MOTION.enterMs,
	exitMs = OVERLAY_MOTION.exitMs,
	onEntered,
	onExited,
}: UseOverlayPresenceOptions): OverlayPresence {
	const [phase, setPhase] = useState<PresencePhase>(isOpen ? "entering" : "closed");
	const progress = useSharedValue(0);
	const isReduced = useReducedMotion();
	const generation = useRef(0);
	const isOpenRequested = useRef(isOpen);
	const onEnteredRef = useRef(onEntered);
	const onExitedRef = useRef(onExited);

	useEffect(() => {
		onEnteredRef.current = onEntered;
		onExitedRef.current = onExited;
	}, [onEntered, onExited]);

	const send = useCallback((event: PresenceEvent) => {
		setPhase((current) => reducePresence(current, event));
	}, []);

	const isCurrent = useCallback(
		(type: "entered" | "exited", finishGeneration: number) =>
			isCurrentFinish(
				{ type, generation: finishGeneration },
				{ generation: generation.current, isOpen: isOpenRequested.current }
			),
		[]
	);

	const finishEnter = useCallback(
		(finishGeneration: number) => {
			if (!isCurrent("entered", finishGeneration)) return;
			send({ type: "entered" });
			onEnteredRef.current?.();
		},
		[isCurrent, send]
	);

	const finishExit = useCallback(
		(finishGeneration: number) => {
			if (!isCurrent("exited", finishGeneration)) return;
			send({ type: "exited" });
			onExitedRef.current?.();
		},
		[isCurrent, send]
	);

	useEffect(() => {
		isOpenRequested.current = isOpen;
		send({ type: isOpen ? "open" : "close" });
	}, [isOpen, send]);

	useEffect(() => {
		if (phase !== "entering" && phase !== "exiting") return;
		generation.current += 1;
		const current = generation.current;
		if (phase === "entering") {
			progress.value = withTiming(
				presenceTarget(phase),
				{ duration: enterMs, easing: ENTER_EASING, reduceMotion: ReduceMotion.Never },
				(finished) => {
					if (finished) scheduleOnRN(finishEnter, current);
				}
			);
		} else {
			progress.value = withTiming(
				presenceTarget(phase),
				{ duration: exitMs, easing: EXIT_EASING, reduceMotion: ReduceMotion.Never },
				(finished) => {
					if (finished) scheduleOnRN(finishExit, current);
				}
			);
		}
	}, [phase, progress, enterMs, exitMs, finishEnter, finishExit]);

	return { isPresent: isPresent(phase), progress, isReduced, phase };
}
