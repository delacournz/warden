export const PRESSABLE_FEEDBACKS = ["scale", "fade", "scale-fade", "none"] as const;

export type PressableFeedback = (typeof PRESSABLE_FEEDBACKS)[number];

/** What a press interpolates towards. 1 is the neutral value on either axis. */
export type PressedState = {
	opacity: number;
	scale: number;
};

/**
 * How a press moves each axis, by name.
 *
 * `scale-fade` is composed from the two single-axis modes rather than given
 * numbers of its own, so tuning `scale` or `fade` carries through to it and the
 * name keeps describing what the mode does.
 *
 * There is no mode involving a ripple, ink or highlight overlay — AGENTS.md
 * rules those out for every pressable in this library.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const PRESSABLE_FEEDBACK: Record<PressableFeedback, PressedState> = {
	scale: { opacity: 1, scale: 0.97 },
	fade: { opacity: 0.6, scale: 1 },
	"scale-fade": { opacity: 0.6, scale: 0.97 },
	none: { opacity: 1, scale: 1 },
};

/**
 * The pair a pressable uses with no `feedback` and no explicit values.
 *
 * Deliberately not one of the named modes. It fades less than `fade` does, so
 * naming it would either change what a bare `Pressable` has always done or
 * force `scale-fade` to fade less than `fade` — and a caller who wants a named
 * mode can just say so.
 */
export const PRESSABLE_FEEDBACK_FALLBACK: PressedState = { opacity: 0.9, scale: 0.97 };

/**
 * Folds a named feedback and any explicit values into the pair a press
 * interpolates towards.
 *
 * An explicit `pressedScale` / `pressedOpacity` wins on its own axis and leaves
 * the other one to the named mode, so `feedback="scale-fade"` with
 * `pressedOpacity={0.2}` is a deeper fade at the mode's scale rather than an
 * all-or-nothing choice between the two APIs.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolvePressedState(
	feedback: PressableFeedback | undefined,
	pressedScale: number | undefined,
	pressedOpacity: number | undefined
): PressedState {
	const named = feedback ? PRESSABLE_FEEDBACK[feedback] : PRESSABLE_FEEDBACK_FALLBACK;

	return {
		opacity: pressedOpacity ?? named.opacity,
		scale: pressedScale ?? named.scale,
	};
}

/**
 * The opacity a pressable rests at, read from what its `className` resolved to.
 *
 * The press feedback is an animated style, and an animated style owns every
 * key it writes on the view — so a resting `opacity: 1` overwrote a caller's
 * `opacity-50` and a disabled `Button`, `Badge` or `ListGroup.Item` never
 * faded. The press now multiplies this in rather than replacing it. Uniwind
 * types the value as animatable, so anything that is not a finite number is
 * treated as unset, and a number is clamped into `[0, 1]`.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveRestOpacity(resolved: unknown): number {
	if (typeof resolved !== "number" || !Number.isFinite(resolved)) return 1;
	return Math.min(1, Math.max(0, resolved));
}
