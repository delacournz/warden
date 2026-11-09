import type { Driver, Element, KeyName, Modifier, Point, Rect, Snapshot } from "../driver/driver.types";
import { canActOnElements } from "../driver/element-actions";
import { canDetectAlerts, canObserve, OBSERVATION_MAX_AGE_MS } from "../driver/observation-cache";
import { elementKey } from "../driver/settle";
import { pressKeys, typeText } from "../driver/typing";
import { E2eError } from "../errors";
import {
	assertDegrees,
	assertScale,
	centreOf,
	fieldValue,
	focusPoint,
	graphemes,
	isOnScreen,
	type Momentum,
	maskedReading,
	PINCH_MS,
	pinchRadius,
	ROTATE_MS,
	requireGesture,
	rotateRadius,
	type SwipeDirection,
	screenRect,
	swipeVector,
	tapPointOf,
	visibleRect,
} from "./actions";
import type { Earlier, Observed, Runtime } from "./context";
import { type DegradedRead, degradedFailure, degradedRead, type ReactNote } from "./degraded-read";
import {
	type ClearMethod,
	confirmFieldValue,
	confirmReadsFor,
	type FillVia,
	focusAndClear,
	focusClearType,
	hitTestField,
	tapToFocus,
} from "./field";
import { COVER_SCROLL_SWIPE, coverOf, dismissKeyboard, scrollPath } from "./keyboard-cover";
import type { NodeEntry } from "./nodes";
import { clearTapPoint, describeBlocker, REVEAL_SWIPE, revealPath, type TapPointResult } from "./occlusion";
import type { PollStep } from "./poll";
import {
	type RoleOptions,
	roleQuery,
	selectorExpression,
	type TestIdOptions,
	type TextQueryOptions,
	testIdQuery,
	textQuery,
	withScope,
} from "./queries";
import { describeExpression, exactlyOne, type LocatorExpression, type Query, resolve } from "./query";
import { type ReactMatch, reactTapPoint } from "./react-locator";
import { mergeReactMatches } from "./react-merge";
import type { QueryRole } from "./roles";
import { normalizeText, type TextMatch } from "./text";

export type ActionOptions = { timeout?: number };

/** What `locator.read()` saw in one look: no match is just `{ visible: false }`. */
export type LocatorReading = {
	visible: boolean;
	/** what `text()` returns; absent when nothing matched */
	text?: string;
	/** what `value()` returns; absent when nothing matched */
	value?: string;
	/** only for a node that can be checked (a switch, a checkbox) */
	checked?: boolean;
};

/** What shows a tap landed: a locator that becomes visible, or a check that resolves true. */
export type TapUntil = Locator | (() => Promise<boolean>);

export type TapOptions = ActionOptions & {
	position?: Point;
	/**
	 * Tap again when this does not show up. A locator counts once it is visible; a function once it resolves true (its
	 * reads share one snapshot per check). After the tap and after each re-tap the wait is `windowMs`, except that the
	 * last re-tap is not waited on: like a hand-rolled tap-and-check helper, `tap` returns and the next assertion says
	 * whether it landed. With a locator, the screen is also compared with the one the press aimed from: once it
	 * changed (a spinner, a disabled button, the target gone) the press landed and is never sent again, however late
	 * `until` is; a screen that has not changed at all is pressed again from 750 ms on, without waiting out `windowMs`.
	 */
	until?: TapUntil;
	/** extra taps when `until` has not shown within `windowMs` of the previous tap. Default 2. Needs `until`. */
	retries?: number;
	/** how long each tap gets to show `until`. Default 4000 ms. Needs `until`. */
	windowMs?: number;
	/** gap between checks of `until`. Default 250 ms. Needs `until`. */
	pollMs?: number;
};
/** `fill` puts the text in by paste where the driver can (iOS) or types it: see `FillVia`. A retry always types. */
export type FillOptions = ActionOptions & { via?: FillVia };
export type LongPressOptions = ActionOptions & { durationMs?: number };
export type PressOptions = ActionOptions & { modifiers?: readonly Modifier[] };
export type LocatorSwipeOptions = ActionOptions & { direction: SwipeDirection; momentum?: Momentum };
/** A pinch or rotate: `radius` is each finger's distance from the centre at the start, in points. */
export type PinchOptions = ActionOptions & { durationMs?: number; radius?: number };
export type RotateOptions = PinchOptions;
export type ScrollOptions = ActionOptions & { direction?: SwipeDirection; momentum?: Momentum; maxSwipes?: number };
export type WaitState = "attached" | "detached" | "visible" | "hidden";
export type WaitForOptions = ActionOptions & { state?: WaitState };

const WAIT_STATES: readonly WaitState[] = ["attached", "detached", "visible", "hidden"];
const DEFAULT_MAX_SWIPES = 10;
/** How long `fill` waits for the field to show what was typed. */
const VERIFY_MS = 1000;
/** A read-back always gets this long, even when the action timeout is nearly spent (it needs two reads 100 ms apart). */
const CONFIRM_FLOOR_MS = 500;
/** Quiet time asked of the driver after each scroll step. */
const SCROLL_SETTLE = { quietMs: 150, timeoutMs: 1000 };

/** Swipes one tap spends scrolling a target out from under the keyboard. */
const MAX_COVER_SCROLLS = 3;
/** How often a target covered by something that cannot be scrolled away is looked at again. */
const COVER_RECHECK_MS = 100;
/** A `tap({ until })` this soon after another input first waits for a still screen (`stillBeforeAim`). */
const RECENT_INPUT_MS = 1500;
const AIM_SETTLE = { quietMs: 250, timeoutMs: 1500 };
/**
 * How long `isVisible()` / `isHidden()` / `count()` look again at a degraded read before `READ_DEGRADED` (capped by the
 * action timeout): long enough for a stalled bridge's background probe or the React tree to settle it, short enough
 * that a spec branching on the answer is not held for the whole action timeout.
 */
const QUICK_CHECK_WINDOW_MS = 2000;

function assertOptions(verb: string, options: object, allowed: readonly string[]): void {
	const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new E2eError(
			"INVALID_ARGUMENT",
			`${verb} does not take ${unknown.map((key) => `"${key}"`).join(", ")}; it takes ${allowed.join(", ")}`
		);
	}
}

/** What the last attempt of a wait saw, for the error when time runs out. */
type Seen =
	| { kind: "none"; snapshot: Observed["snapshot"] }
	| { kind: "blocked"; reason: string; snapshot: Observed["snapshot"] }
	| { kind: "react"; snapshot: Observed["snapshot"]; matches: number }
	| { kind: "degraded"; read: DegradedRead; snapshot: Observed["snapshot"] }
	| { kind: "driver"; message: string };

/**
 * What one look says about a locator. `nodes`: the accessibility tree's answer (none included, when the read was whole
 * or the React tree confirmed the absence). `react`: the read was degraded and the React tree has the component(s).
 * `unknown`: the read was degraded (`screen/degraded-read.ts`) and nothing could confirm the locator either way.
 */
export type Resolved =
	| { kind: "nodes"; entries: NodeEntry[] }
	| { kind: "react"; matches: ReactMatch[] }
	| { kind: "unknown"; read: DegradedRead };

/** A look that settled the locator one way or the other. */
type Conclusive = { entries: NodeEntry[]; react: ReactMatch[] | undefined; observed: Observed };

/** Whether a component found only in the React tree shows on screen. */
function reactVisible(match: ReactMatch, observed: Observed): boolean {
	return match.frame.width > 0 && match.frame.height > 0 && isOnScreen(match.tapPoint, observed.snapshot.screen);
}

type Actionable = { entry: NodeEntry; observed: Observed };

/** A component found only in the React tree (no accessibility node): enough to tap, nothing more. */
type ReactActionable = { react: ReactMatch; observed: Observed };

const REACT_ONLY =
	"exists only in the React tree, not in the accessibility tree, so only tap() and boundingBox() work on it; " +
	"expose it to accessibility (accessible, accessibilityLabel) to use anything else";

/** The testID of a plain `getByTestId` (no scope), the only query the React tree can answer. */
function plainTestId(expr: LocatorExpression): TextMatch | undefined {
	if (expr.kind !== "query" || expr.scope !== undefined || expr.query.kind !== "testId") return undefined;
	return expr.query.value;
}

type ActionSpec = {
	/** refuse disabled elements */
	enabled: boolean;
	/** refuse elements whose tap point is off screen */
	tapPointOnScreen: boolean;
};

const LOCATOR_BRAND = Symbol.for("@delacour/warden-e2e/locator");

/** Whether `value` is a `Locator` (also across duplicated copies of this module, e.g. the bundled entry and the preload). */
export function isLocator(value: unknown): value is Locator {
	return typeof value === "object" && value !== null && LOCATOR_BRAND in value;
}

export class Locator {
	readonly [LOCATOR_BRAND] = true;

	constructor(
		readonly expr: LocatorExpression,
		private readonly rt: Runtime
	) {}

	toString(): string {
		return describeExpression(this.expr);
	}

	// ---- queries, scoped to this locator's subtree ----

	private scoped(query: Query): Locator {
		return new Locator({ kind: "query", query, scope: this.expr }, this.rt);
	}

	getByTestId(id: TextMatch, options?: TestIdOptions): Locator {
		return this.scoped(testIdQuery(id, options));
	}

	getByText(text: TextMatch, options?: TextQueryOptions): Locator {
		return this.scoped(textQuery("text", text, options));
	}

	getByLabel(text: TextMatch, options?: TextQueryOptions): Locator {
		return this.scoped(textQuery("label", text, options));
	}

	getByPlaceholder(text: TextMatch, options?: TextQueryOptions): Locator {
		return this.scoped(textQuery("placeholder", text, options));
	}

	getByValue(value: TextMatch, options?: TextQueryOptions): Locator {
		return this.scoped(textQuery("value", value, options));
	}

	getByRole(role: QueryRole, nameOrOptions?: TextMatch | RoleOptions, options?: Omit<RoleOptions, "name">): Locator {
		return this.scoped(roleQuery(role, nameOrOptions, options));
	}

	locator(selector: string): Locator {
		return new Locator(withScope(selectorExpression(selector), this.expr), this.rt);
	}

	// ---- refinement ----

	filter(options: { hasText?: TextMatch; has?: Locator }): Locator {
		const unknown = Object.keys(options).filter((key) => key !== "hasText" && key !== "has");
		if (unknown.length > 0) {
			throw new E2eError(
				"INVALID_LOCATOR",
				`filter takes "hasText" and "has", not ${unknown.map((k) => `"${k}"`).join(", ")}`
			);
		}
		const { hasText, has } = options;
		if (hasText === undefined && has === undefined) {
			throw new E2eError("INVALID_LOCATOR", 'filter needs "hasText" or "has"');
		}
		if (has !== undefined && !(has instanceof Locator)) {
			throw new E2eError("INVALID_LOCATOR", 'filter "has" must be a locator made by screen');
		}
		return new Locator(
			{
				kind: "filter",
				source: this.expr,
				...(hasText === undefined ? {} : { hasText }),
				...(has === undefined ? {} : { has: has.expr }),
			},
			this.rt
		);
	}

	first(): Locator {
		return new Locator({ kind: "index", source: this.expr, index: "first" }, this.rt);
	}

	last(): Locator {
		return new Locator({ kind: "index", source: this.expr, index: "last" }, this.rt);
	}

	nth(index: number): Locator {
		if (!Number.isInteger(index) || index < 0) {
			throw new E2eError("INVALID_LOCATOR", `nth takes a non-negative integer, got ${String(index)}`);
		}
		return new Locator({ kind: "index", source: this.expr, index }, this.rt);
	}

	// ---- reads: one look at the screen, never waiting ----

	/** The runtime (host, timeouts, clock) this locator runs on; the `expect` matchers poll through it. */
	get runtime(): Runtime {
		return this.rt;
	}

	/** One look at the screen: every current match and the snapshot they came from. Never waits. */
	async look(options: { reuse?: boolean } = {}): Promise<{ entries: NodeEntry[]; observed: Observed }> {
		const observed = await this.rt.observe(options);
		return { entries: resolve(this.expr, observed.index), observed };
	}

	/**
	 * What `observed` says about this locator. A whole read, or one with matches, is the accessibility tree's answer. A
	 * degraded read with no match is asked of the React tree (plain `getByTestId` with devtools): it answers presence or
	 * absence; otherwise the look is `unknown`, and no caller may take it as "absent". A component whose rect is an
	 * accessibility node's (the fallback reader kept the node, dropped the testID) resolves to that node, so text,
	 * visibility and actions read it like any match; one with no such node stays a React-only match.
	 */
	async resolveIn(observed: Observed): Promise<Resolved> {
		const entries = resolve(this.expr, observed.index);
		if (entries.length > 0) return { kind: "nodes", entries };
		const read = degradedRead(observed.snapshot);
		if (read === undefined) return { kind: "nodes", entries };
		const testId = plainTestId(this.expr);
		const lookup = testId === undefined ? undefined : await this.rt.reactLookup(testId, observed);
		if (lookup === undefined || !lookup.answered) return { kind: "unknown", read };
		if (lookup.matches.length === 0) return { kind: "nodes", entries };
		const merged = mergeReactMatches(lookup.matches, observed.index);
		return merged === undefined ? { kind: "react", matches: lookup.matches } : { kind: "nodes", entries: merged };
	}

	/** Why the React tree did not settle a degraded look, for the `READ_DEGRADED` message. */
	reactNote(): ReactNote {
		if (plainTestId(this.expr) === undefined) return "not-testid";
		return this.rt.hasReactTree() ? "unanswered" : "no-devtools";
	}

	/** `READ_DEGRADED` for this locator after `waitedMs`, with the screen of the last degraded look. */
	degradedFailure(read: DegradedRead, waitedMs: number, snapshot: Observed["snapshot"] | undefined): E2eError {
		const screen = snapshot === undefined ? undefined : this.rt.excerpt(snapshot);
		return degradedFailure(this.toString(), read, waitedMs, this.reactNote(), screen);
	}

	/**
	 * One look that settles this locator. A whole read answers at once (never waits); a degraded one that cannot say
	 * whether the locator is there is looked at again until one can, within the action timeout (`quick`: within
	 * `QUICK_CHECK_WINDOW_MS`, for checks a spec branches on), then `READ_DEGRADED`.
	 */
	private async conclusive(options: { reuse?: boolean; quick?: boolean } = {}): Promise<Conclusive> {
		const first = await this.look(options.reuse === undefined ? {} : { reuse: options.reuse });
		const settled = await this.settled(first.observed);
		if (settled !== undefined) return settled;
		const actionMs = this.rt.actionTimeout();
		const timeoutMs = options.quick === true ? Math.min(actionMs, QUICK_CHECK_WINDOW_MS) : actionMs;
		let last: { read: DegradedRead; snapshot: Observed["snapshot"] } | undefined;
		const result = await this.rt.poll<Conclusive, undefined>(async () => {
			const observation = await this.rt.tryObserve({ reuse: false });
			if (!observation.ok) {
				if (!observation.error.retryable) throw new E2eError("DRIVER", `snapshot failed: ${observation.error.message}`);
				return { done: false, state: undefined };
			}
			const answer = await this.settled(observation.observed);
			if (answer !== undefined) return { done: true, value: answer };
			const read = degradedRead(observation.observed.snapshot);
			if (read !== undefined) last = { read, snapshot: observation.observed.snapshot };
			return { done: false, state: undefined };
		}, timeoutMs);
		if (result.status === "done") return result.value;
		const fallback = degradedRead(first.observed.snapshot);
		const read = last?.read ?? fallback;
		if (read === undefined) throw new E2eError("TIMEOUT", `${this} could not be read within ${timeoutMs} ms`);
		throw this.degradedFailure(read, timeoutMs, last?.snapshot ?? first.observed.snapshot);
	}

	/** The conclusive answer of `observed`, or undefined while it is `unknown`. */
	private async settled(observed: Observed): Promise<Conclusive | undefined> {
		const resolved = await this.resolveIn(observed);
		if (resolved.kind === "unknown") return undefined;
		if (resolved.kind === "react") return { entries: [], react: resolved.matches, observed };
		return { entries: resolved.entries, react: undefined, observed };
	}

	private async matches(): Promise<{ entries: NodeEntry[]; observed: Observed }> {
		const { entries, observed } = await this.conclusive();
		return { entries, observed };
	}

	/** The one React match a read of a component the accessibility tree lacks stands for; several are ambiguous. */
	private reactOnly(matches: readonly ReactMatch[], observed: Observed): ReactMatch {
		const [only, ...others] = matches;
		if (only !== undefined && others.length === 0) return only;
		throw new E2eError(
			"LOCATOR_AMBIGUOUS",
			`${this} matched ${matches.length} components in the React tree`,
			this.rt.excerpt(observed.snapshot),
			matches.length
		);
	}

	private async single(): Promise<{ entry: NodeEntry; observed: Observed }> {
		const { entries, observed } = await this.matches();
		if (entries.length === 0 && (await this.reactCandidates(observed)).length > 0) {
			throw new E2eError("NOT_ACTIONABLE", `${this} ${REACT_ONLY}`, this.rt.excerpt(observed.snapshot));
		}
		return { entry: this.exactlyOne(entries, observed), observed };
	}

	/** Components of the React tree that this locator names, when it is a plain `getByTestId` and the app has devtools. */
	private async reactCandidates(observed: Observed): Promise<ReactMatch[]> {
		const testId = plainTestId(this.expr);
		return testId === undefined ? [] : this.rt.reactMatches(testId, observed);
	}

	private exactlyOne(entries: readonly NodeEntry[], observed: Observed): NodeEntry {
		return pickOne(this.rt, this.expr, entries, observed);
	}

	/** One read as a trace-only `read.<name>` span naming this locator; reads that call another read are not wrapped twice. */
	private traced<T>(name: string, run: () => Promise<T>): Promise<T> {
		return this.rt.span(`read.${name}`, run, { detail: () => ({ locator: this.toString() }) });
	}

	count(): Promise<number> {
		return this.traced("count", async () => {
			const { entries, react } = await this.conclusive({ quick: true });
			return react?.length ?? entries.length;
		});
	}

	async all(): Promise<Locator[]> {
		const count = await this.count();
		return Array.from({ length: count }, (_, index) => this.nth(index));
	}

	text(): Promise<string> {
		return this.traced("text", async () => {
			const { entries, react, observed } = await this.conclusive();
			if (react !== undefined) return this.reactText(this.reactOnly(react, observed), observed);
			if (entries.length === 0 && (await this.reactCandidates(observed)).length > 0) {
				throw new E2eError("NOT_ACTIONABLE", `${this} ${REACT_ONLY}`, this.rt.excerpt(observed.snapshot));
			}
			return textOf(this.exactlyOne(entries, observed));
		});
	}

	allTexts(): Promise<string[]> {
		return this.traced("allTexts", async () => {
			const { entries, react, observed } = await this.conclusive();
			if (react !== undefined) return react.map((match) => this.reactText(match, observed));
			return entries.map(textOf);
		});
	}

	/** The text the React tree reported for a component of a degraded read that no accessibility node stands for. */
	private reactText(match: ReactMatch, observed: Observed): string {
		if (match.text !== undefined) return normalizeText(match.text);
		throw new E2eError("NOT_ACTIONABLE", `${this} ${REACT_ONLY}`, this.rt.excerpt(observed.snapshot));
	}

	value(): Promise<string> {
		return this.traced("value", async () => fieldValue((await this.single()).entry));
	}

	isVisible(): Promise<boolean> {
		return this.traced("isVisible", async () => {
			const { entries, react, observed } = await this.conclusive({ quick: true });
			if (react !== undefined) return reactVisible(this.reactOnly(react, observed), observed);
			return entries.length > 0 && this.exactlyOne(entries, observed).visible;
		});
	}

	/**
	 * Visibility, text, value and checked state from ONE look at the screen: where `isVisible()` then `text()` read the
	 * screen for each (sharing a snapshot only when nothing was pressed in between and it is still young), this is one
	 * read by construction. No match is `{ visible: false }` and never waits; several matches fail like `text()`.
	 * `text` is what `text()` returns, `value` what `value()` returns, `checked` is there only for a node that can be
	 * checked (a switch, a checkbox).
	 */
	read(): Promise<LocatorReading> {
		return this.traced("read", async () => {
			const { entries, react, observed } = await this.conclusive();
			if (react !== undefined) {
				const match = this.reactOnly(react, observed);
				const visible = reactVisible(match, observed);
				return match.text === undefined ? { visible } : { visible, text: normalizeText(match.text) };
			}
			if (entries.length === 0) return { visible: false };
			const entry = this.exactlyOne(entries, observed);
			return {
				visible: entry.visible,
				text: textOf(entry),
				value: fieldValue(entry),
				...(entry.states.checked === undefined ? {} : { checked: entry.states.checked }),
			};
		});
	}

	/** Whether this locator's one match is visible in `observed`; no match is not visible, several matches throw. */
	/**
	 * Whether `observed` shows this locator, without waiting: a degraded read is resolved like `resolveIn` (the React
	 * tree's node or rect), and one nothing could settle counts as not shown yet.
	 */
	async shownIn(observed: Observed): Promise<boolean> {
		const resolved = await this.resolveIn(observed);
		if (resolved.kind === "unknown") return false;
		if (resolved.kind === "react") return reactVisible(this.reactOnly(resolved.matches, observed), observed);
		return resolved.entries.length > 0 && this.exactlyOne(resolved.entries, observed).visible;
	}

	async isHidden(): Promise<boolean> {
		return !(await this.isVisible());
	}

	isEnabled(): Promise<boolean> {
		return this.traced("isEnabled", async () => !(await this.single()).entry.states.disabled);
	}

	isChecked(): Promise<boolean> {
		return this.traced("isChecked", async () => (await this.single()).entry.states.checked === true);
	}

	/** Always a new snapshot: a frame is for aiming at, and one from a screen that was still moving is wrong. */
	boundingBox(): Promise<Rect> {
		return this.traced("boundingBox", async () => {
			const { entries, observed } = await this.conclusive({ reuse: false });
			if (entries.length === 0) {
				const [only, ...others] = await this.reactCandidates(observed);
				if (only !== undefined && others.length === 0) return { ...only.frame };
			}
			return { ...this.exactlyOne(entries, observed).element.frame };
		});
	}

	/** Polls until the locator is `visible` (default), `hidden`, `attached` or `detached`; else `TIMEOUT`. */
	waitFor(options: WaitForOptions = {}): Promise<void> {
		return this.traced("waitFor", () => this.waitForState(options));
	}

	private async waitForState(options: WaitForOptions): Promise<void> {
		assertOptions("waitFor", options, ["state", "timeout"]);
		const state = options.state ?? "visible";
		if (!WAIT_STATES.includes(state)) {
			throw new E2eError(
				"INVALID_ARGUMENT",
				`waitFor state must be one of ${WAIT_STATES.join(", ")}, got "${String(state)}"`
			);
		}
		const timeoutMs = options.timeout ?? this.rt.actionTimeout();
		type Last = { snapshot: Observed["snapshot"]; degraded?: DegradedRead };
		const result = await this.rt.poll<true, Last | undefined>(async (attempt) => {
			const observation = await this.rt.tryObserve({ reuse: attempt === 1 });
			if (!observation.ok) {
				if (!observation.error.retryable) throw new E2eError("DRIVER", `snapshot failed: ${observation.error.message}`);
				return { done: false, state: undefined };
			}
			const { observed } = observation;
			const resolved = await this.resolveIn(observed);
			if (resolved.kind === "unknown")
				return { done: false, state: { snapshot: observed.snapshot, degraded: resolved.read } };
			const done =
				resolved.kind === "react"
					? reachedByReact(state, reactVisible(this.reactOnly(resolved.matches, observed), observed))
					: reached(state, resolved.entries.length === 0 ? undefined : this.exactlyOne(resolved.entries, observed));
			return done ? { done: true, value: true } : { done: false, state: { snapshot: observed.snapshot } };
		}, timeoutMs);
		if (result.status === "done") return;
		const last = result.last;
		if (last?.degraded !== undefined) throw this.degradedFailure(last.degraded, timeoutMs, last.snapshot);
		const message = `${this} did not become ${state} within ${timeoutMs} ms`;
		throw new E2eError("TIMEOUT", message, last === undefined ? undefined : this.rt.excerpt(last.snapshot));
	}

	// ---- actions: wait for actionability, then act once ----

	private act<T>(verb: string, run: () => Promise<T>, suffix = ""): Promise<T> {
		return this.rt.step(`${verb} ${this}${suffix}`, run);
	}

	/**
	 * Waits for exactly one visible (and, per `spec`, enabled, on-screen) match. Several matches fail at once.
	 * With `allowReact` a component that only the React tree knows (a plain `getByTestId`) counts as a match.
	 * Every look here is a new snapshot, never the one a read or an `expect` kept: the action goes to where the element
	 * is now, and a snapshot taken while the screen was still sliding in has it somewhere else. (A plain `tap` on a
	 * driver with a cheap hit-test first tries `aimFromKept`, which checks the kept snapshot with a hit-test instead.)
	 * A fresh snapshot can also be of a screen still moving, so a match is taken only once its frame held still across
	 * two looks with no input between them (Playwright's "stable"): the look a read or an `expect` kept, when there is
	 * one, costs nothing; with none, a look less than `STABLE_INPUT_GAP_MS` after an input is checked by one more: a
	 * hit-test at the element where that is cheap (`stillByHitTest`), else a snapshot. An element that never stops
	 * moving is taken after `MAX_STABILITY_LOOKS` extra looks.
	 */
	private actionable(spec: ActionSpec, timeoutMs: number): Promise<Actionable>;
	private actionable(spec: ActionSpec, timeoutMs: number, allowReact: boolean): Promise<Actionable | ReactActionable>;
	private async actionable(
		spec: ActionSpec,
		timeoutMs: number,
		allowReact = false
	): Promise<Actionable | ReactActionable> {
		let extraLooks = 0;
		const result = await this.rt.poll<Actionable | ReactActionable, Seen>(async () => {
			for (;;) {
				const step = await this.actionableLook(spec, allowReact, extraLooks >= MAX_STABILITY_LOOKS);
				if (step !== "moving") return step;
				extraLooks += 1;
			}
		}, timeoutMs);
		if (result.status === "done") return result.value;
		const seen = result.last;
		if (seen?.kind === "blocked") {
			throw new E2eError(
				"NOT_ACTIONABLE",
				`${this} ${seen.reason} (waited ${timeoutMs} ms)`,
				this.rt.excerpt(seen.snapshot)
			);
		}
		if (seen?.kind === "react") {
			throw new E2eError(
				"NOT_ACTIONABLE",
				`${this} ${REACT_ONLY} (waited ${timeoutMs} ms)`,
				this.rt.excerpt(seen.snapshot),
				seen.matches
			);
		}
		if (seen?.kind === "driver") throw new E2eError("DRIVER", `snapshot kept failing: ${seen.message}`);
		if (seen?.kind === "degraded") throw this.degradedFailure(seen.read, timeoutMs, seen.snapshot);
		throw new E2eError(
			"LOCATOR_NOT_FOUND",
			`${this} matched no elements within ${timeoutMs} ms`,
			seen === undefined ? undefined : this.rt.excerpt(seen.snapshot)
		);
	}

	/** One look of `actionable`: done, not yet, or `moving` (the match has not held still yet; look again at once). */
	private async actionableLook(
		spec: ActionSpec,
		allowReact: boolean,
		anyFrame: boolean
	): Promise<PollStep<Actionable | ReactActionable, Seen> | "moving"> {
		const observation = await this.rt.tryObserve({ reuse: false, withPrevious: true });
		if (!observation.ok) {
			if (!observation.error.retryable) {
				throw new E2eError("DRIVER", `snapshot failed: ${observation.error.code}: ${observation.error.message}`);
			}
			return { done: false, state: { kind: "driver", message: observation.error.message } };
		}
		const { observed } = observation;
		const entries = resolve(this.expr, observed.index);
		if (entries.length === 0) return this.reactStep(spec, observed, allowReact);
		const entry = this.exactlyOne(entries, observed);
		const reason = blockedReason(entry, spec, observed);
		if (reason !== undefined) return { done: false, state: { kind: "blocked", reason, snapshot: observed.snapshot } };
		if (!anyFrame && !this.heldStill(entry, observation.earlier)) {
			const compared = observation.earlier?.previous !== undefined;
			if (compared || !(await this.stillByHitTest(entry, observed))) return "moving";
		}
		return { done: true, value: { entry, observed } };
	}

	/**
	 * The second look of the stable-frame rule as a hit-test, where that is cheap (`capabilities.cheapHitTest`, iOS:
	 * one element back instead of the whole tree): the element held still when the hit at its tap point is that element
	 * (`sameElement`, as in `aimFromKept`). Only for a look with nothing to compare against (the one that followed an
	 * input): a look that differs from the one before it is known to be moving. Never with system alerts answered: the
	 * app-scoped hit-test may not see an alert that came up since the look, the full second look does.
	 */
	private async stillByHitTest(entry: NodeEntry, observed: Observed): Promise<boolean> {
		const { driver } = observed;
		if (driver.capabilities.cheapHitTest !== true || this.rt.host.answerSystemAlert !== undefined) return false;
		const hit = await driver.elementAtPoint(tapPointOf(entry));
		return hit.success && hit.data !== null && sameElement(hit.data, entry.element);
	}

	/**
	 * Whether `entry`'s frame, to 1 pt, is where the look before this one had this locator's one match. Without that look:
	 * still unless an input ended less than `STABLE_INPUT_GAP_MS` before this one. No observation cache = still (no history).
	 */
	private heldStill(entry: NodeEntry, earlier: Earlier | undefined): boolean {
		if (earlier === undefined) return true;
		const { previous, sinceInputMs } = earlier;
		if (previous === undefined) return sinceInputMs === undefined || sinceInputMs >= STABLE_INPUT_GAP_MS;
		const [before, ...others] = resolve(this.expr, previous.index);
		return before !== undefined && others.length === 0 && sameFrame(before.element.frame, entry.element.frame);
	}

	/**
	 * Where a hit-test is cheap (`capabilities.cheapHitTest`, iOS), the tap after an assertion need not take a second
	 * snapshot: when the observation cache holds one it would still reuse (younger than `OBSERVATION_MAX_AGE_MS` for the
	 * platform) with no input since, its one
	 * actionable match is hit-tested at the tap point, and the match is taken as is when the hit is that element (same
	 * role, identifier, label, enabled state and frame to 1 pt). That hit is also the second look of the stable-frame
	 * rule: the element is where the snapshot had it. Anything else (no such snapshot, an alert on it, several or no
	 * matches, a blocked match, a hit on a child or a neighbour, a failed hit-test) is undefined: `actionable` looks again.
	 * Never with system alerts answered (`answerSystemAlert`, `test.use({ systemAlerts })`): an alert that came up after
	 * the kept snapshot sits outside the app, where the app-scoped hit-test may not see it, and the fresh look answers it.
	 */
	private async aimFromKept(spec: ActionSpec, position: Point | undefined): Promise<Actionable | undefined> {
		const driver = await this.rt.host.driver();
		if (driver.capabilities.cheapHitTest !== true || !canObserve(driver)) return undefined;
		if (this.rt.host.answerSystemAlert !== undefined) return undefined;
		const kept = driver.peek?.();
		if (
			kept === undefined ||
			kept.ageMs >= OBSERVATION_MAX_AGE_MS[driver.platform] ||
			showsAlert(driver, kept.snapshot)
		)
			return undefined;
		const observation = await this.rt.tryObserve({ reuse: true, alerts: false });
		if (!observation.ok || observation.observed.snapshot !== kept.snapshot) return undefined;
		const { observed } = observation;
		const [entry, ...others] = resolve(this.expr, observed.index);
		if (entry === undefined || others.length > 0 || blockedReason(entry, spec, observed) !== undefined)
			return undefined;
		const hit = await observed.driver.elementAtPoint(tapPointOf(entry, position));
		if (!hit.success || hit.data === null || !sameElement(hit.data, entry.element)) return undefined;
		return { entry, observed };
	}

	/**
	 * A target under the on-screen keyboard (the default `software` mode keeps it up) would get the touch on a key. In a
	 * scroll container it is scrolled into the free part of the screen (at most `MAX_COVER_SCROLLS` swipes, each looked at
	 * fresh); otherwise, or when scrolling does not clear it, the keyboard is dismissed once (`dismissKeyboard`). Either way
	 * the match is looked at again, and whatever that look shows is what the action uses: no retry.
	 */
	private async clearOfKeyboard(
		found: Actionable,
		spec: ActionSpec,
		position: Point | undefined,
		timeoutMs: number
	): Promise<Actionable> {
		const coverAt = (at: Actionable) => coverOf(at.entry, tapPointOf(at.entry, position), at.observed.snapshot);
		let current = found;
		let cover = coverAt(current);
		if (cover === undefined) return found;
		const { driver } = found.observed;
		for (let scrolls = 0; cover?.scroller !== undefined && scrolls < MAX_COVER_SCROLLS; scrolls += 1) {
			const path = scrollPath(cover.scroller, cover.shift);
			this.rt.drive("scrollIntoView", await driver.swipe(path.from, path.to, COVER_SCROLL_SWIPE));
			await driver.settle(SCROLL_SETTLE);
			current = await this.actionable(spec, timeoutMs);
			cover = coverAt(current);
		}
		if (cover === undefined) return current;
		this.rt.drive("dismissKeyboard", await dismissKeyboard(driver));
		await driver.settle(SCROLL_SETTLE);
		return this.actionable(spec, timeoutMs);
	}

	/**
	 * Where a press reaches the match itself (`occlusion.ts`): its tap point, or the part of it no later control covers
	 * (a sticky footer, a tab bar). A match wholly covered inside a scroll container is dragged clear (at most
	 * `MAX_COVER_SCROLLS` drags, each looked at fresh); one that cannot be is looked at again until `timeoutMs` (a cover
	 * may go away) and then fails `NOT_ACTIONABLE` naming the cover, instead of pressing the cover.
	 */
	private async aimClear(
		found: Actionable,
		spec: ActionSpec,
		timeoutMs: number
	): Promise<{ found: Actionable; point: Point }> {
		const deadline = this.rt.clock.now() + timeoutMs;
		let current = found;
		for (let scrolls = 0; ; ) {
			const result = clearTapPoint(current.entry, current.observed.index);
			if (result.kind === "clear") return { found: current, point: result.point };
			const path = scrolls < MAX_COVER_SCROLLS ? revealPath(current.entry, result, current.observed.index) : undefined;
			if (path !== undefined) {
				scrolls += 1;
				this.rt.drive("scrollIntoView", await current.observed.driver.swipe(path.from, path.to, REVEAL_SWIPE));
				await current.observed.driver.settle(SCROLL_SETTLE);
			} else if (this.rt.clock.now() >= deadline) {
				throw new E2eError(
					"NOT_ACTIONABLE",
					`${this} is ${describeBlocker(result)}, which would take the touch; scroll it clear or wait for the cover to go`,
					this.rt.excerpt(current.observed.snapshot)
				);
			} else await this.pause(COVER_RECHECK_MS);
			current = await this.actionable(spec, Math.max(1, deadline - this.rt.clock.now()));
		}
	}

	/**
	 * Taps the one visible, enabled match. With `until` it is also the retrying tap: the press on a tab bar or a list row
	 * right after a navigation is sometimes dropped with nothing on screen to tell, so it checks that `until` shows
	 * within `windowMs` and presses again, up to `retries` more times.
	 */
	async tap(options: TapOptions = {}): Promise<void> {
		assertOptions("tap", options, ["position", "timeout", "until", "retries", "windowMs", "pollMs"]);
		const retry = retryPlan(options);
		const suffix = retry === undefined ? "" : ` until ${describeUntil(retry.until)}`;
		return this.act(
			"tap",
			async () => {
				if (retry !== undefined) await this.stillBeforeAim();
				let before = await this.tapOnce(options);
				if (retry === undefined) return;
				for (let resent = 0; resent < retry.retries; resent += 1) {
					const outcome = await this.arrivedWithin(retry, before);
					// a screen that reacted got the press: pressing again would be a second submit or toggle
					if (outcome !== "press-again") return;
					before = await this.tapOnce(options);
				}
			},
			suffix
		);
	}

	/**
	 * Before the first press of a `tap({ until })` that comes right after another input (`RECENT_INPUT_MS`), waits for
	 * the screen to go still (`driver.settle`). The press is judged against the screen it aimed from: one aimed mid
	 * transition (the screen a Back returns to, still sliding in and gaining nodes) sees the transition's own changes as
	 * the press landing, and a press that was dropped is never sent again. A still screen costs one quiet settle.
	 */
	private async stillBeforeAim(): Promise<void> {
		const driver = await this.rt.host.driver();
		const since = canObserve(driver) ? driver.previous?.().sinceInputMs : undefined;
		if (since === undefined || since >= RECENT_INPUT_MS) return;
		await driver.settle(AIM_SETTLE);
	}

	/**
	 * One press; resolves to the snapshot it aimed from (the screen just before the press) and the element pressed (none
	 * for a match only the React tree knows). A plain tap may aim from the kept snapshot (`aimFromKept`); a tap with
	 * `until` takes a fresh look, since the screen it aimed from is what the checks compare against to tell the press
	 * landed, and an older one could differ only because it was older.
	 */
	private async tapOnce(options: TapOptions): Promise<AimedFrom> {
		const withPosition = options.position !== undefined;
		const spec = { enabled: !withPosition, tapPointOnScreen: !withPosition };
		const timeoutMs = options.timeout ?? this.rt.actionTimeout();
		const look =
			(options.until === undefined ? await this.aimFromKept(spec, options.position) : undefined) ??
			(await this.actionable(spec, timeoutMs, true));
		const cleared = "entry" in look ? await this.clearOfKeyboard(look, spec, options.position, timeoutMs) : look;
		const aim = "entry" in cleared && !withPosition ? await this.aimClear(cleared, spec, timeoutMs) : undefined;
		const found = aim?.found ?? cleared;
		const point =
			aim?.point ??
			("react" in found ? reactTapPoint(found.react, options.position) : tapPointOf(found.entry, options.position));
		const { driver } = found.observed;
		// a screen reader changes what a touch means, so a resolved element is pressed through its accessibility action
		const aimed: AimedFrom = {
			snapshot: found.observed.snapshot,
			target: "entry" in found ? found.entry.element : undefined,
		};
		if (!withPosition && "entry" in found && canActOnElements(driver)) {
			if (this.rt.drive("tap", await driver.pressElement(found.entry.element))) return aimed;
		}
		this.rt.drive("tap", await driver.tap(point));
		return aimed;
	}

	/**
	 * Polls `plan.until` for `plan.windowMs`, one look at the screen per check, the first one right after the press
	 * (`driver.tap` returns once the HID press is over, ~85 ms, and an AX read queues behind the app's main thread, so
	 * that look usually already shows the screen the press made; measured: holding it back to `pollMs` saved no read
	 * and cost 250 ms a press). A locator is checked on the snapshot of
	 * the poll itself, which is also compared with the screen the press aimed from (`reacted`): once the screen reacted
	 * the press landed, so it is never sent again (`landed`, even when `until` is late); a screen that has not reacted
	 * on `UNCHANGED_CHECKS` checks in a row from `UNCHANGED_AFTER_MS` on is pressed again at once. A function
	 * is called with the kept snapshot forgotten (after the first check), so its own reads take one new snapshot
	 * between them rather than the previous check's; it gets the whole window.
	 */
	private async arrivedWithin(plan: RetryPlan, aimed: AimedFrom): Promise<TapOutcome> {
		const { until } = plan;
		const watch: PressWatch = {
			identities: new Set(aimed.snapshot.flat.map(identityKey)),
			frames: new Set(aimed.snapshot.flat.map(elementKey)),
			target: aimed.target === undefined ? undefined : identityKey(aimed.target),
			started: this.rt.clock.now(),
			changed: false,
			unchanged: 0,
		};
		const result = await this.rt.poll<TapOutcome, undefined>(
			async (attempt) => {
				if (typeof until !== "function") return this.checkLocatorUntil(until, watch, attempt);
				if (attempt > 1) await this.rt.forgetObservation();
				return (await until()) ? { done: true, value: "arrived" } : { done: false, state: undefined };
			},
			plan.windowMs,
			{ intervalMs: plan.pollMs }
		);
		if (result.status === "done") return result.value;
		return watch.changed ? "landed" : "press-again";
	}

	/** One check of a locator `until`: shown, the press looks dropped (`press-again`), or not yet (noting whether the screen moved). */
	private async checkLocatorUntil(
		until: Locator,
		watch: PressWatch,
		attempt: number
	): Promise<PollStep<TapOutcome, undefined>> {
		const observation = await until.runtime.tryObserve({ reuse: attempt === 1 });
		if (!observation.ok) {
			if (!observation.error.retryable) {
				throw new E2eError("DRIVER", `snapshot failed: ${observation.error.code}: ${observation.error.message}`);
			}
			watch.unchanged = 0;
			return { done: false, state: undefined };
		}
		if (await until.shownIn(observation.observed)) return { done: true, value: "arrived" };
		const seen = reaction(observation.observed.snapshot, watch);
		if (seen === "none") watch.unchanged += 1;
		else if (seen === "motion") {
			// still moving: no sign either way; count unchanged checks from where it stops
			watch.frames = new Set(observation.observed.snapshot.flat.map(elementKey));
			watch.unchanged = 0;
		} else {
			watch.changed = true;
			watch.unchanged = 0;
		}
		const dropped =
			!watch.changed &&
			watch.unchanged >= UNCHANGED_CHECKS &&
			this.rt.clock.now() - watch.started >= UNCHANGED_AFTER_MS;
		return dropped ? { done: true, value: "press-again" } : { done: false, state: undefined };
	}

	async longPress(options: LongPressOptions = {}): Promise<void> {
		assertOptions("longPress", options, ["durationMs", "timeout"]);
		return this.act("longPress", async () => {
			const spec = { enabled: true, tapPointOnScreen: true };
			const timeoutMs = options.timeout ?? this.rt.actionTimeout();
			const cleared = await this.clearOfKeyboard(await this.actionable(spec, timeoutMs), spec, undefined, timeoutMs);
			const { found, point } = await this.aimClear(cleared, spec, timeoutMs);
			const opts = options.durationMs === undefined ? undefined : { durationMs: options.durationMs };
			this.rt.drive("longPress", await found.observed.driver.longPress(point, opts));
		});
	}

	/**
	 * Replaces the content of a text field: focus with the caret at the end, empty it (select all and type over the selection when
	 * the driver can, nothing for a field that is empty or shows a placeholder), type, then poll until the field holds
	 * the text on consecutive reads (the accessibility value lags the keys). A mismatch is retried once with one Backspace
	 * per character and a retype (a field that refuses select-all). `via` (default `"type"`) is how the text goes in on
	 * the first attempt: `"paste"` pastes on iOS (through the simulator pasteboard, which Xcode syncs with the Mac
	 * clipboard and so with every other sim) and types where the driver cannot paste or the pasteboard write fails; the
	 * retry always types, so a field that mangles a paste (a mask, a maxLength) still ends up right. Secure fields cannot be read back, so they are not
	 * verified.
	 */
	async fill(text: string, options: FillOptions = {}): Promise<void> {
		assertOptions("fill", options, ["via", "timeout"]);
		const via = fillViaOf(this, options.via);
		return this.act("fill", async () => {
			const budget = this.rt.budget(options.timeout);
			let target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			// decided once: a field that only shows as secure after the first attempt (masked read-back) stays verified
			const verify = !target.entry.secure;
			let firstHeld: string | undefined;
			for (let attempt = 1; ; attempt += 1) {
				const point = focusPoint(target.entry.element.frame);
				this.rt.drive(
					"fill",
					await focusClearType(
						target.observed.driver,
						this.pause,
						point,
						target.entry,
						text,
						clearMethodFor(attempt),
						process.env,
						viaFor(attempt, via)
					)
				);
				if (!verify) return;
				const outcome = await this.confirm(target, text, budget);
				if (outcome.ok) return;
				if (attempt === 2) {
					throw new E2eError(
						"ACTION_FAILED",
						`${this}: ${fillMismatch(text, target.entry.secure, outcome.held, firstHeld)}`,
						outcome.screen
					);
				}
				firstHeld = outcome.held;
				target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			}
		});
	}

	/** Empties a text field (select all and one Backspace when the driver can), then checks it is empty (one more pass of counted Backspaces when it is not). */
	async clear(options: ActionOptions = {}): Promise<void> {
		assertOptions("clear", options, ["timeout"]);
		return this.act("clear", async () => {
			const budget = this.rt.budget(options.timeout);
			let target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			const before = rawValue(target.entry);
			for (let attempt = 1; ; attempt += 1) {
				await this.focusAndClear(target, clearMethodFor(attempt));
				if (target.entry.secure) return;
				const outcome = await this.confirm(target, "", budget, before);
				if (outcome.ok) return;
				if (attempt === 2) return this.lastClearCheck(target, budget, before, outcome);
				target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			}
		});
	}

	/** Types at the caret; the field is tapped (caret to the end) first unless it already has focus. */
	async type(text: string, options: ActionOptions = {}): Promise<void> {
		assertOptions("type", options, ["timeout"]);
		return this.act("type", async () => {
			const target = await this.actionable(
				{ enabled: true, tapPointOnScreen: false },
				options.timeout ?? this.rt.actionTimeout()
			);
			await this.focus(target);
			this.rt.drive("type", await typeText(target.observed.driver, this.pause, text));
		});
	}

	async press(key: KeyName, options: PressOptions = {}): Promise<void> {
		assertOptions("press", options, ["modifiers", "timeout"]);
		return this.act("press", async () => {
			const target = await this.actionable(
				{ enabled: true, tapPointOnScreen: false },
				options.timeout ?? this.rt.actionTimeout()
			);
			await this.focus(target);
			this.rt.drive("press", await target.observed.driver.key(key, options.modifiers));
		});
	}

	/** A scroll gesture on this one node, in the direction the content moves. */
	async swipe(options: LocatorSwipeOptions): Promise<void> {
		assertOptions("swipe", options, ["direction", "momentum", "timeout"]);
		if (options.direction === undefined) {
			throw new E2eError("INVALID_ARGUMENT", "a locator swipe needs a direction; paths are only for screen.swipe");
		}
		return this.act("swipe", async () => {
			const { entry, observed } = await this.actionable(
				{ enabled: false, tapPointOnScreen: false },
				options.timeout ?? this.rt.actionTimeout()
			);
			if (canActOnElements(observed.driver)) {
				if (this.rt.drive("swipe", await observed.driver.scrollElement(options.direction, entry.element))) return;
			}
			const vector = swipeVector(
				options.direction,
				visibleRect(entry.element.frame, observed.snapshot.screen),
				options.momentum
			);
			this.rt.drive("swipe", await observed.driver.swipe(vector.from, vector.to, vector.options));
		});
	}

	/**
	 * A two-finger pinch centred on this node's visible part: `scale` above 1 spreads the fingers (zoom in), below 1
	 * brings them together. `INVALID_ARGUMENT` for a scale outside 0.1-10 or exactly 1, or on a driver without pinch.
	 */
	async pinch(scale: number, options: PinchOptions = {}): Promise<void> {
		assertOptions("pinch", options, ["durationMs", "radius", "timeout"]);
		assertScale(scale);
		return this.act(
			"pinch",
			async () => {
				const { entry, observed } = await this.actionable(
					{ enabled: false, tapPointOnScreen: false },
					options.timeout ?? this.rt.actionTimeout()
				);
				const screen = observed.snapshot.screen;
				const rect = visibleRect(entry.element.frame, screen);
				requireGesture(observed.driver, "pinch", "locator.pinch");
				this.rt.drive(
					"pinch",
					await observed.driver.pinch(centreOf(rect), scale, {
						durationMs: options.durationMs ?? PINCH_MS,
						radius: options.radius ?? pinchRadius(rect, scale, screen),
					})
				);
			},
			` ×${scale}`
		);
	}

	/** A two-finger rotation about this node's visible centre; positive `degrees` turn clockwise. */
	async rotate(degrees: number, options: RotateOptions = {}): Promise<void> {
		assertOptions("rotate", options, ["durationMs", "radius", "timeout"]);
		assertDegrees(degrees);
		return this.act(
			"rotate",
			async () => {
				const { entry, observed } = await this.actionable(
					{ enabled: false, tapPointOnScreen: false },
					options.timeout ?? this.rt.actionTimeout()
				);
				const screen = observed.snapshot.screen;
				const rect = visibleRect(entry.element.frame, screen);
				requireGesture(observed.driver, "pinch", "locator.rotate");
				this.rt.drive(
					"rotate",
					await observed.driver.rotate(centreOf(rect), degrees, {
						durationMs: options.durationMs ?? ROTATE_MS,
						radius: options.radius ?? rotateRadius(rect, screen),
					})
				);
			},
			` ${degrees}°`
		);
	}

	/** Scrolls the screen until this locator is on screen. */
	scrollTo(options: ScrollOptions = {}): Promise<void> {
		return scrollUntilVisible(this.rt, this, options);
	}

	/** One poll step when the accessibility tree has no match: ask the React tree (plain `getByTestId` only). */
	private async reactStep(
		spec: ActionSpec,
		observed: Observed,
		allowReact: boolean
	): Promise<PollStep<ReactActionable, Seen>> {
		const read = degradedRead(observed.snapshot);
		const testId = plainTestId(this.expr);
		const lookup = testId === undefined ? undefined : await this.rt.reactLookup(testId, observed);
		const found = lookup?.answered === true ? lookup.matches : [];
		const [match, ...others] = found;
		if (match === undefined) {
			// a degraded read the React tree could not settle is not "none": the node may be there
			if (read !== undefined && lookup?.answered !== true) {
				return { done: false, state: { kind: "degraded", read, snapshot: observed.snapshot } };
			}
			return { done: false, state: { kind: "none", snapshot: observed.snapshot } };
		}
		if (!allowReact)
			return { done: false, state: { kind: "react", snapshot: observed.snapshot, matches: found.length } };
		if (others.length > 0) {
			throw new E2eError(
				"LOCATOR_AMBIGUOUS",
				`${this} matched ${found.length} components in the React tree`,
				this.rt.excerpt(observed.snapshot),
				found.length
			);
		}
		if (spec.tapPointOnScreen && !isOnScreen(match.tapPoint, observed.snapshot.screen)) {
			const reason = "(React tree) has its tap point outside the screen";
			return { done: false, state: { kind: "blocked", reason, snapshot: observed.snapshot } };
		}
		return { done: true, value: { react: match, observed } };
	}

	private async focus({ entry, observed }: Actionable): Promise<void> {
		if (entry.states.focused) return;
		this.rt.drive("focus", await tapToFocus(observed.driver, this.pause, focusPoint(entry.element.frame), entry));
	}

	private async focusAndClear({ entry, observed }: Actionable, method: ClearMethod): Promise<void> {
		this.rt.drive(
			"clear",
			await focusAndClear(observed.driver, this.pause, focusPoint(entry.element.frame), entry, method)
		);
	}

	/** After the counted pass: passes a field that is empty behind its placeholder, else fails with what it holds. */
	private async lastClearCheck(
		target: Actionable,
		budget: { remaining(): number },
		before: string,
		outcome: { held: string; screen: string | undefined }
	): Promise<void> {
		if (outcome.held === before && (await this.emptyBehindPlaceholder(target, budget))) return;
		throw new E2eError(
			"ACTION_FAILED",
			`${this}: clear did not empty the field: it holds ${JSON.stringify(outcome.held)}`,
			outcome.screen
		);
	}

	/**
	 * Whether a field that still shows what it showed before two clears is empty behind a placeholder: iOS reports
	 * `placeholder: null` for React Native inputs and shows the placeholder as the value, so an empty field reads as if
	 * it held that text, and deleting changes nothing. One probe key settles it: an empty field then holds just the
	 * probe, a field with text holds more. The probe is deleted either way.
	 */
	private async emptyBehindPlaceholder(target: Actionable, budget: { remaining(): number }): Promise<boolean> {
		const { driver } = target.observed;
		this.rt.drive("clear", await typeText(driver, this.pause, CLEAR_PROBE));
		const probed = await this.confirm(target, CLEAR_PROBE, budget);
		this.rt.drive("clear", await pressKeys(driver, this.pause, "Backspace", 1));
		return probed.ok;
	}

	/** Sleeps on the runtime's clock (a fake one in tests), ending early when the attempt aborts. */
	private readonly pause = (ms: number): Promise<void> => this.rt.clock.sleep(ms, this.rt.host.signal);

	/**
	 * Polls until the field holds `text` on consecutive reads. Each read is a hit-test at the field's centre (a full
	 * snapshot with the keyboard up takes 300-1000 ms and slows the app that is digesting the keys), falling back to a
	 * scoped re-query when the hit-test cannot tell. The deadline is `VERIFY_MS`, extended while the value changes.
	 */
	private async confirm(
		{ entry, observed }: Actionable,
		text: string,
		budget: { remaining(): number },
		clearedFrom?: string
	): Promise<{ ok: true } | { ok: false; held: string; screen: string | undefined }> {
		const span = Math.max(budget.remaining(), CONFIRM_FLOOR_MS);
		let lastSeen: Observed["snapshot"] | undefined;
		// a field not known as secure when the fill started (an empty one on a read without its secure trait) can read
		// back masked: its bullets are counted against the typed text
		const readValue = (found: NodeEntry): string => {
			if (text === "") return clearedValue(fieldValue(found), clearedFrom);
			return found.secure ? maskedReading(found, text) : rawValue(found);
		};
		const outcome = await confirmFieldValue<never>({
			text,
			now: this.rt.clock.now,
			sleep: this.pause,
			budgetMs: Math.min(VERIFY_MS, span),
			reads: confirmReadsFor(entry, text),
			maxMs: span,
			read: async () => {
				const hit = await hitTestField(observed.driver, entry);
				if (hit.ok && hit.entry !== undefined)
					return { ok: true, reading: { kind: "value", value: readValue(hit.entry) } };
				const observation = await this.rt.tryObserve({ reuse: false, alerts: false });
				if (!observation.ok) return { ok: true, reading: { kind: "unreadable", note: "(unreadable)" } };
				lastSeen = observation.observed.snapshot;
				const found = resolve(this.expr, observation.observed.index);
				const [only] = found;
				if (found.length !== 1 || only === undefined) {
					return { ok: true, reading: { kind: "unreadable", note: `(${found.length} matches)` } };
				}
				return { ok: true, reading: { kind: "value", value: readValue(only) } };
			},
		});
		if (outcome.status === "confirmed") return { ok: true };
		const held = outcome.status === "mismatch" ? outcome.held : "(unreadable)";
		return { ok: false, held, screen: lastSeen === undefined ? undefined : this.rt.excerpt(lastSeen) };
	}
}

/** The strict one-match rule; the error carries the rendered screen, which is only built when there is an error. */
export function pickOne(
	rt: Runtime,
	expr: LocatorExpression,
	entries: readonly NodeEntry[],
	observed: Observed
): NodeEntry {
	const [only] = entries;
	if (only !== undefined && entries.length === 1) return only;
	const result = exactlyOne(expr, entries, { screen: rt.excerpt(observed.snapshot) });
	if (!result.success) throw result.error;
	return result.data;
}

/** Display text: the accessible name, else the text of everything inside. */
export function textOf(entry: NodeEntry): string {
	return normalizeText(entry.name ?? "") || entry.subtreeText;
}

/** A look that starts this soon after an input, with no earlier look of the same screen, is checked by one more. */
const STABLE_INPUT_GAP_MS = 300;
/** At most this many extra looks wait for a frame to hold still; then the latest one is used. */
const MAX_STABILITY_LOOKS = 2;

/** Whether a hit-test answer is the element a snapshot had: same role, ids, enabled state and frame (to 1 pt). */
function sameElement(hit: Element, seen: Element): boolean {
	return (
		hit.role === seen.role &&
		hit.identifier === seen.identifier &&
		hit.label === seen.label &&
		hit.enabled === seen.enabled &&
		sameFrame(hit.frame, seen.frame)
	);
}

function showsAlert(driver: Driver, snapshot: Snapshot): boolean {
	return snapshot.modal !== undefined || (canDetectAlerts(driver) && driver.alertIn(snapshot) !== null);
}

function sameFrame(a: Rect, b: Rect): boolean {
	return (
		Math.round(a.x) === Math.round(b.x) &&
		Math.round(a.y) === Math.round(b.y) &&
		Math.round(a.width) === Math.round(b.width) &&
		Math.round(a.height) === Math.round(b.height)
	);
}

/** A tap with `until` is sent again this many times, each given this long to show its result, checked this often. */
const TAP_RETRIES = 2;
const TAP_WINDOW_MS = 4000;
const TAP_CHECK_MS = 250;

/**
 * A screen that still matches the pre-press one on this many checks in a row, this long after the press, dropped it:
 * press again without waiting out the window.
 */
const UNCHANGED_CHECKS = 2;
const UNCHANGED_AFTER_MS = 750;

type RetryPlan = { until: TapUntil; retries: number; windowMs: number; pollMs: number };

/** How one press's window ended: `until` showed; the screen reacted without it (no second press); or press again. */
type TapOutcome = "arrived" | "landed" | "press-again";

/** What a press aimed from: the screen just before it and the element pressed (none for a React-only match). */
type AimedFrom = { snapshot: Snapshot; target: Element | undefined };

/** What the checks after one press have seen of the screen. */
type PressWatch = {
	/** `identityKey` of every node of the snapshot the press aimed from */
	identities: ReadonlySet<string>;
	/** `elementKey` (frames included) of every node of the last look that moved, first the aimed-from snapshot */
	frames: ReadonlySet<string>;
	/** `identityKey` of the element pressed */
	target: string | undefined;
	started: number;
	/** some check saw the screen react: the press landed */
	changed: boolean;
	/** checks in a row that saw no reaction */
	unchanged: number;
};

/** A node without its frame: role, identifier, label and value. */
function identityKey(element: Element): string {
	return JSON.stringify([element.role, element.identifier ?? null, element.label ?? null, element.value ?? null]);
}

/**
 * What `snapshot` shows of the press `watch` follows. `identity`: a node the aimed-from screen did not have (a new
 * element, or one whose label or value changed), or the pressed element gone: the press landed. `motion`: the same
 * nodes, only moved since the last look: no sign either way (right after a Back, the screen it returns to is still
 * sliding in, a transition that drops presses; counting its frames as a reaction kept a dropped press from being sent
 * again). `none`: nothing changed. Nodes that only left are not a reaction either: right after a navigation the screen
 * it left and a keyboard going down stay in the tree until the transition ends.
 */
function reaction(snapshot: Snapshot, watch: PressWatch): "identity" | "motion" | "none" {
	const now = new Set<string>();
	let moved = false;
	for (const element of snapshot.flat) {
		const identity = identityKey(element);
		if (!watch.identities.has(identity)) return "identity";
		now.add(identity);
		if (!watch.frames.has(elementKey(element))) moved = true;
	}
	if (watch.target !== undefined && !now.has(watch.target)) return "identity";
	return moved ? "motion" : "none";
}

function wholeNumber(name: string, value: number, atLeast: number): void {
	if (!Number.isInteger(value) || value < atLeast) {
		throw new E2eError(
			"INVALID_ARGUMENT",
			`tap ${name} must be an integer of at least ${atLeast}, got ${String(value)}`
		);
	}
}

/** The retry settings of a `tap`, validated; undefined for a plain tap. `retries`, `windowMs` and `pollMs` mean nothing without `until`. */
function retryPlan(options: TapOptions): RetryPlan | undefined {
	const { until, retries, windowMs, pollMs } = options;
	if (until === undefined) {
		const orphan = (["retries", "windowMs", "pollMs"] as const).filter((key) => options[key] !== undefined);
		if (orphan.length > 0) {
			throw new E2eError(
				"INVALID_ARGUMENT",
				`tap ${orphan.map((key) => `"${key}"`).join(", ")} only apply with "until"`
			);
		}
		return undefined;
	}
	if (typeof until !== "function" && !isLocator(until)) {
		throw new E2eError(
			"INVALID_ARGUMENT",
			'tap "until" must be a locator made by screen, or a function returning a promise of a boolean'
		);
	}
	const plan: RetryPlan = {
		until,
		retries: retries ?? TAP_RETRIES,
		windowMs: windowMs ?? TAP_WINDOW_MS,
		pollMs: pollMs ?? TAP_CHECK_MS,
	};
	wholeNumber("retries", plan.retries, 0);
	wholeNumber("windowMs", plan.windowMs, 1);
	wholeNumber("pollMs", plan.pollMs, 1);
	return plan;
}

function describeUntil(until: TapUntil): string {
	return typeof until === "function" ? "check" : String(until);
}

/** The `via` a `fill` asked for (default type); anything but `paste` / `type` is `INVALID_ARGUMENT`. */
function fillViaOf(locator: Locator, via: FillVia | undefined): FillVia {
	if (via === undefined || via === "paste" || via === "type") return via ?? "type";
	throw new E2eError("INVALID_ARGUMENT", `${locator}: fill via must be "paste" or "type", got ${JSON.stringify(via)}`);
}

/** The first attempt puts the text in as asked; a retry means that did not work, so it types. */
function viaFor(attempt: number, via: FillVia): FillVia {
	return attempt === 1 ? via : "type";
}

/** The first attempt empties a field the quick way; a retry means that did not work, so it presses one Backspace per character. */
/** The key `clear` types to tell an empty field showing its placeholder from one holding that text: caseless, so autocapitalisation leaves it alone. */
const CLEAR_PROBE = "1";

function clearMethodFor(attempt: number): ClearMethod {
	return attempt === 1 ? "auto" : "counted";
}

/** What the field shows, placeholder and all (used to compare against what was typed). */
/** Why a fill failed. A field that reads masked is never quoted the typed text: only its length. */
function fillMismatch(text: string, secure: boolean, held: string, firstHeld: string | undefined): string {
	const expected = secure ? `${graphemes(text)} characters (secure)` : JSON.stringify(text);
	const earlier = firstHeld === undefined ? "" : ` (first attempt held ${JSON.stringify(firstHeld)})`;
	return `fill did not take: expected ${expected} but the field holds ${JSON.stringify(held)}${earlier}`;
}

/**
 * What a cleared field holds, given what it held before the clear. Deleting only removes characters, so text left
 * behind is a subsequence of what was there. A value that is not one is a placeholder the element does not name (iOS
 * reports `placeholder: null` for React Native inputs and shows the placeholder as the value): the field is empty.
 */
export function clearedValue(value: string, before: string | undefined): string {
	if (value === "" || before === undefined) return value;
	return isSubsequence(value, before) ? value : "";
}

function isSubsequence(part: string, whole: string): boolean {
	let at = 0;
	for (const char of whole) {
		if (at < part.length && part.startsWith(char, at)) at += char.length;
	}
	return at === part.length;
}

function rawValue(entry: NodeEntry): string {
	return entry.value ?? (entry.role === "textbox" || entry.role === "searchbox" ? (entry.element.text ?? "") : "");
}

function reached(state: WaitState, entry: NodeEntry | undefined): boolean {
	switch (state) {
		case "attached":
			return entry !== undefined;
		case "detached":
			return entry === undefined;
		case "visible":
			return entry?.visible === true;
		case "hidden":
			return entry === undefined || !entry.visible;
	}
}

/** `reached` for a component only the React tree has: it is attached, and visible when its rect is on screen. */
function reachedByReact(state: WaitState, visible: boolean): boolean {
	switch (state) {
		case "attached":
			return true;
		case "detached":
			return false;
		case "visible":
			return visible;
		case "hidden":
			return !visible;
	}
}

function blockedReason(entry: NodeEntry, spec: ActionSpec, observed: Observed): string | undefined {
	if (!entry.visible) return "is not visible";
	if (spec.enabled && entry.states.disabled) return "is disabled";
	if (spec.tapPointOnScreen && !isOnScreen(tapPointOf(entry), observed.snapshot.screen)) {
		return "has its tap point outside the screen; use scrollTo() to bring it into view";
	}
	return undefined;
}

function isOnScreenEntry(entry: NodeEntry | undefined, observed: Observed): boolean {
	return entry?.visible === true && isOnScreen(tapPointOf(entry), observed.snapshot.screen);
}

/** Why `scrollUntilVisible` gave up; a target missing from a degraded read is `READ_DEGRADED`, not "not found". */
function scrollGaveUp(
	target: Locator,
	absent: boolean,
	effort: string,
	observed: Observed,
	waitedMs: number,
	aim?: ReturnType<typeof clearTapPoint>
): E2eError {
	const read = absent ? degradedRead(observed.snapshot) : undefined;
	if (read !== undefined) return target.degradedFailure(read, waitedMs, observed.snapshot);
	const screen = target.runtime.excerpt(observed.snapshot);
	if (absent) return new E2eError("LOCATOR_NOT_FOUND", `${target} was not found after ${effort}`, screen);
	if (aim?.kind === "covered") {
		return new E2eError("NOT_ACTIONABLE", `${target} is still ${describeBlocker(aim)} after ${effort}`, screen);
	}
	return new E2eError("NOT_ACTIONABLE", `${target} is still not on screen after ${effort}`, screen);
}

/** Where `entry` can be tapped, when it is on screen at all. */
function aimOnScreen(entry: NodeEntry | undefined, observed: Observed): TapPointResult | undefined {
	return entry !== undefined && isOnScreenEntry(entry, observed) ? clearTapPoint(entry, observed.index) : undefined;
}

/**
 * One step of `scrollUntilVisible`: a target on screen but under a sticky footer or header, or cut by its list's
 * edge, is dragged clear rather than a whole page further; anything else is one scroll in `direction`.
 */
async function scrollToward(
	rt: Runtime,
	observed: Observed,
	entry: NodeEntry | undefined,
	aim: TapPointResult | undefined,
	direction: NonNullable<ScrollOptions["direction"]>,
	momentum: ScrollOptions["momentum"]
): Promise<void> {
	const reveal =
		entry !== undefined && aim?.kind === "covered"
			? revealPath(entry, aim, observed.index, { screenWhenUnknown: true })
			: undefined;
	if (reveal !== undefined) {
		rt.drive("scrollUntilVisible", await observed.driver.swipe(reveal.from, reveal.to, REVEAL_SWIPE));
	} else await scrollOnce(rt, observed, direction, momentum);
	await observed.driver.settle(SCROLL_SETTLE);
}

/** One scroll step toward `scrollUntilVisible`'s target: the driver's own element scroll when it has one, else a swipe. */
async function scrollOnce(
	rt: Runtime,
	observed: Awaited<ReturnType<Runtime["observe"]>>,
	direction: NonNullable<ScrollOptions["direction"]>,
	momentum: ScrollOptions["momentum"]
): Promise<void> {
	const vector = swipeVector(direction, screenRect(observed.snapshot.screen), momentum);
	const scrolled =
		canActOnElements(observed.driver) && rt.drive("scrollUntilVisible", await observed.driver.scrollElement(direction));
	if (!scrolled) rt.drive("scrollUntilVisible", await observed.driver.swipe(vector.from, vector.to, vector.options));
}

/**
 * Swipes the screen in `direction` (the way the content moves) until `target` has exactly one match that is on screen.
 * Gives up after `maxSwipes` swipes or the action timeout.
 */
export async function scrollUntilVisible(rt: Runtime, target: Locator, options: ScrollOptions = {}): Promise<void> {
	assertOptions("scrollUntilVisible", options, ["direction", "momentum", "maxSwipes", "timeout"]);
	const direction = options.direction ?? "down";
	const maxSwipes = options.maxSwipes ?? DEFAULT_MAX_SWIPES;
	if (!Number.isInteger(maxSwipes) || maxSwipes < 0) {
		throw new E2eError("INVALID_ARGUMENT", `maxSwipes must be a non-negative integer, got ${String(maxSwipes)}`);
	}
	return rt.step(`scrollUntilVisible ${target}`, async () => {
		const budget = rt.budget(options.timeout);
		for (let swipes = 0; ; swipes += 1) {
			const observed = await rt.observe();
			const entries = resolve(target.expr, observed.index);
			if (entries.length > 1) pickOne(rt, target.expr, entries, observed);
			const [entry] = entries;
			const aim = aimOnScreen(entry, observed);
			if (aim?.kind === "clear") return;
			if (swipes >= maxSwipes || budget.remaining() <= 0) {
				const effort = `${swipes} swipes ${direction}`;
				throw scrollGaveUp(target, entry === undefined, effort, observed, budget.total, aim);
			}
			await scrollToward(rt, observed, entry, aim, direction, options.momentum);
		}
	});
}
