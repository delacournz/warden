/**
 * Where an overlay is in its life: absent, arriving, shown, or leaving.
 *
 * `exiting` is the whole reason this exists — an overlay that unmounted the
 * moment it closed would have no exit animation to play.
 */
export type PresencePhase = "closed" | "entering" | "open" | "exiting";

export type PresenceEvent =
	/** The owner asked for it to show. */
	| { type: "open" }
	/** The owner asked for it to hide. */
	| { type: "close" }
	/** The entrance animation finished. */
	| { type: "entered" }
	/** The exit animation finished. */
	| { type: "exited" };

/**
 * The presence machine as a pure reducer.
 *
 * A re-open during the exit reverses into `entering` from wherever the
 * animation is, and a close during the entrance reverses into `exiting`. A
 * finish event from an animation that was interrupted — `entered` while
 * already `exiting` — is stale and changes nothing. The reducer only sees the
 * phase, though, so the hook also checks `isCurrentFinish` before it sends a
 * finish or fires `onEntered`/`onExited`.
 */
export function reducePresence(phase: PresencePhase, event: PresenceEvent): PresencePhase {
	switch (event.type) {
		case "open":
			return phase === "closed" || phase === "exiting" ? "entering" : phase;
		case "close":
			return phase === "entering" || phase === "open" ? "exiting" : phase;
		case "entered":
			return phase === "entering" ? "open" : phase;
		case "exited":
			return phase === "exiting" ? "closed" : phase;
	}
}

/** Whether the overlay is mounted: every phase but `closed`. */
export function isPresent(phase: PresencePhase): boolean {
	return phase !== "closed";
}

/** The progress value the phase animates toward — 1 shown, 0 hidden. */
export function presenceTarget(phase: PresencePhase): 0 | 1 {
	return phase === "entering" || phase === "open" ? 1 : 0;
}

/** A finished animation, tagged with the transition that started it. */
export type PresenceFinish = { type: "entered" | "exited"; generation: number };

/** What the hook knows now: the latest transition and what the owner asked for. */
export type PresenceCurrent = { generation: number; isOpen: boolean };

/**
 * Whether a finish still belongs to the transition in flight.
 *
 * An animation can end on the UI thread just as the owner flips `isOpen`: the
 * finish is already queued for React when the reverse starts. It is stale if a
 * newer transition has started since, or if the owner now wants the opposite
 * end — the second covers the gap before the new phase has rendered. A stale
 * finish must neither move the phase nor reach `onEntered`/`onExited`, or a
 * consumer restores focus away from an overlay that is reopening.
 */
export function isCurrentFinish(finish: PresenceFinish, current: PresenceCurrent): boolean {
	if (finish.generation !== current.generation) return false;
	return finish.type === "entered" ? current.isOpen : !current.isOpen;
}
