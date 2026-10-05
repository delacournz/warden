import { type ReactElement, useId } from "react";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { useSpinnerContext } from "./spinner.context";
import {
	SPINNER_ARC_HEAD_OPACITY,
	SPINNER_ARC_JOINT_OPACITY,
	SPINNER_ARC_STROKE_WIDTH,
	SPINNER_ARC_TAIL_OPACITY,
	spinnerArcStops,
} from "./spinner.variants";

// The ring's geometry, in viewBox units. Everything below is derived from these
// three numbers — the paths, the gradient axis, the head cap and the viewBox —
// so the head cannot end up drawn somewhere the stroke no longer passes.
const CENTRE = 12;
const RADIUS = 10;
const TOP = CENTRE - RADIUS;
const BOTTOM = CENTRE + RADIUS;

const VIEW_BOX = `0 0 ${CENTRE * 2} ${CENTRE * 2}`;
const LEAD_PATH = `M ${CENTRE} ${TOP} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTRE} ${BOTTOM}`;
const TAIL_PATH = `M ${CENTRE} ${BOTTOM} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTRE} ${TOP}`;

const LEAD_STOPS = spinnerArcStops(SPINNER_ARC_HEAD_OPACITY, SPINNER_ARC_JOINT_OPACITY);
const TAIL_STOPS = spinnerArcStops(SPINNER_ARC_TAIL_OPACITY, SPINNER_ARC_JOINT_OPACITY);

/**
 * The default glyph: a ring whose stroke fades from opaque to transparent
 * around the circle.
 *
 * Drawn as two half-rings because a linear gradient only fades along one axis —
 * one alone cannot carry the stroke all the way round. Central Icons has no
 * loader glyph, so this is drawn from SVG primitives rather than imported.
 *
 * It carries no width or height on purpose. react-native-svg resolves both to
 * `'100%'` when neither is set, so the arc fills whatever box the spinner root
 * sized — one place decides the size instead of threading a number down. The
 * viewBox stays fixed at 24, so the stroke stays proportional at every size
 * with no geometry to recompute.
 *
 * **The caps are `butt`, and the round head is a separate `Circle`.** The two
 * half-rings share the endpoint at the bottom of the ring, where both sit at
 * `SPINNER_ARC_JOINT_OPACITY`. Round caps there stack, and two semi-transparent
 * discs composite to roughly 0.8 alpha — a bright dot straddling the joint,
 * opposite the head. Butt caps abut instead, and the one endpoint that actually
 * wants a rounded end gets a disc of its own, drawn last so it sits on top. The
 * tail terminates fully transparent at that same point, so its flat end is
 * invisible and needs nothing. Do not put `strokeLinecap="round"` back.
 *
 * **The gradients run in user space.** The viewBox is fixed and the geometry is
 * hard-coded, so `y = TOP … BOTTOM` is exact — where an object bounding box
 * would leave open whether a given renderer includes the stroke, which shifts
 * both endpoints off 0 and 1 and clips the head and the tail.
 *
 * Reads the spinner context optionally rather than through `useSpinner`: the
 * arc is also the fallback glyph and must not throw outside a `<Spinner>`.
 * Outside one there is no colour to resolve, and every paint here falls back to
 * SVG's own black.
 */
export function SpinnerArc(): ReactElement {
	const spinner = useSpinnerContext();
	const resolvedColor = spinner?.color;

	// An SVG gradient is referenced by id, and ids are global to the document.
	// React 19 emits `«r1»`-style ids, whose delimiters are invalid in `url(#…)`.
	const id = useId().replace(/[^a-zA-Z0-9]/g, "");
	const leadId = `spinner-lead-${id}`;
	const tailId = `spinner-tail-${id}`;

	return (
		<Svg fill="none" viewBox={VIEW_BOX}>
			<Defs>
				<LinearGradient gradientUnits="userSpaceOnUse" id={leadId} x1={0} x2={0} y1={TOP} y2={BOTTOM}>
					{LEAD_STOPS.map((stop) => (
						<Stop key={stop.offset} offset={stop.offset} stopColor={resolvedColor} stopOpacity={stop.opacity} />
					))}
				</LinearGradient>
				<LinearGradient gradientUnits="userSpaceOnUse" id={tailId} x1={0} x2={0} y1={TOP} y2={BOTTOM}>
					{TAIL_STOPS.map((stop) => (
						<Stop key={stop.offset} offset={stop.offset} stopColor={resolvedColor} stopOpacity={stop.opacity} />
					))}
				</LinearGradient>
			</Defs>
			<Path d={LEAD_PATH} stroke={`url(#${leadId})`} strokeLinecap="butt" strokeWidth={SPINNER_ARC_STROKE_WIDTH} />
			<Path d={TAIL_PATH} stroke={`url(#${tailId})`} strokeLinecap="butt" strokeWidth={SPINNER_ARC_STROKE_WIDTH} />
			<Circle cx={CENTRE} cy={TOP} fill={resolvedColor} r={SPINNER_ARC_STROKE_WIDTH / 2} />
		</Svg>
	);
}
SpinnerArc.displayName = "DelacourUI.Spinner.Arc";
