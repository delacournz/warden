import type { Driver, Element, KeyName, Modifier, Point, Rect, Snapshot } from "../driver/driver.types";
import { canDetectAlerts, canObserve, OBSERVATION_MAX_AGE_MS } from "../driver/observation-cache";
import { snapshotHash } from "../driver/settle";
import { typeText } from "../driver/typing";
import { E2eError } from "../errors";
import {
	assertDegrees,
	assertScale,
	centreOf,
	fieldValue,
	focusPoint,
	isOnScreen,
	type Momentum,
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
import {
	type ClearMethod,
	confirmFieldValue,
	confirmReadsFor,
	focusAndClear,
	focusClearType,
	hitTestField,
	tapToFocus,
} from "./field";
import type { NodeEntry } from "./nodes";
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
	| { kind: "driver"; message: string };

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

	private matches(): Promise<{ entries: NodeEntry[]; observed: Observed }> {
		return this.look();
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
		return this.traced("count", async () => (await this.matches()).entries.length);
	}

	async all(): Promise<Locator[]> {
		const count = await this.count();
		return Array.from({ length: count }, (_, index) => this.nth(index));
	}

	text(): Promise<string> {
		return this.traced("text", async () => textOf((await this.single()).entry));
	}

	allTexts(): Promise<string[]> {
		return this.traced("allTexts", async () => (await this.matches()).entries.map(textOf));
	}

	value(): Promise<string> {
		return this.traced("value", async () => fieldValue((await this.single()).entry));
	}

	isVisible(): Promise<boolean> {
		return this.traced("isVisible", async () => this.visibleIn((await this.matches()).observed));
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
			const { entries, observed } = await this.matches();
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
	visibleIn(observed: Observed): boolean {
		const entries = resolve(this.expr, observed.index);
		if (entries.length === 0) return false;
		return this.exactlyOne(entries, observed).visible;
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
			const { entries, observed } = await this.look({ reuse: false });
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
		const result = await this.rt.poll<true, Observed["snapshot"] | undefined>(async (attempt) => {
			const observation = await this.rt.tryObserve({ reuse: attempt === 1 });
			if (!observation.ok) {
				if (!observation.error.retryable) throw new E2eError("DRIVER", `snapshot failed: ${observation.error.message}`);
				return { done: false, state: undefined };
			}
			const { observed } = observation;
			const entries = resolve(this.expr, observed.index);
			const entry = entries.length === 0 ? undefined : this.exactlyOne(entries, observed);
			return reached(state, entry) ? { done: true, value: true } : { done: false, state: observed.snapshot };
		}, timeoutMs);
		if (result.status === "done") return;
		const message = `${this} did not become ${state} within ${timeoutMs} ms`;
		throw new E2eError("TIMEOUT", message, result.last === undefined ? undefined : this.rt.excerpt(result.last));
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
	 * one, costs nothing; with none, a look less than `STABLE_INPUT_GAP_MS` after an input is checked by one more. An
	 * element that never stops moving is taken after `MAX_STABILITY_LOOKS` extra looks.
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
		if (!anyFrame && !this.heldStill(entry, observation.earlier)) return "moving";
		return { done: true, value: { entry, observed } };
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
				let before = await this.tapOnce(options);
				if (retry === undefined) return;
				for (let resent = 0; resent < retry.retries; resent += 1) {
					const outcome = await this.arrivedWithin(retry, snapshotHash(before));
					// a screen that reacted got the press: pressing again would be a second submit or toggle
					if (outcome !== "press-again") return;
					before = await this.tapOnce(options);
				}
			},
			suffix
		);
	}

	/**
	 * One press; resolves to the snapshot it aimed from (the screen just before the press). A plain tap may aim from the
	 * kept snapshot (`aimFromKept`); a tap with `until` takes a fresh look, since the screen it aimed from is what the
	 * checks compare against to tell the press landed, and an older one could differ only because it was older.
	 */
	private async tapOnce(options: TapOptions): Promise<Snapshot> {
		const withPosition = options.position !== undefined;
		const spec = { enabled: !withPosition, tapPointOnScreen: !withPosition };
		const found =
			(options.until === undefined ? await this.aimFromKept(spec, options.position) : undefined) ??
			(await this.actionable(spec, options.timeout ?? this.rt.actionTimeout(), true));
		const point =
			"react" in found ? reactTapPoint(found.react, options.position) : tapPointOf(found.entry, options.position);
		this.rt.drive("tap", await found.observed.driver.tap(point));
		return found.observed.snapshot;
	}

	/**
	 * Polls `plan.until` for `plan.windowMs`, one look at the screen per check. A locator is checked on the snapshot of
	 * the poll itself, which is also compared with `pressedOn` (the hash of the screen the press aimed from): once the
	 * screen changed the press landed, so it is never sent again (`landed`, even when `until` is late); a screen still
	 * unchanged on `UNCHANGED_CHECKS` checks in a row from `UNCHANGED_AFTER_MS` on is pressed again at once. A function
	 * is called with the kept snapshot forgotten (after the first check), so its own reads take one new snapshot
	 * between them rather than the previous check's; it gets the whole window.
	 */
	private async arrivedWithin(plan: RetryPlan, pressedOn: string): Promise<TapOutcome> {
		const { until } = plan;
		const watch: PressWatch = { pressedOn, started: this.rt.clock.now(), changed: false, unchanged: 0 };
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
		if (until.visibleIn(observation.observed)) return { done: true, value: "arrived" };
		if (snapshotHash(observation.observed.snapshot) === watch.pressedOn) watch.unchanged += 1;
		else {
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
			const { entry, observed } = await this.actionable(
				{ enabled: true, tapPointOnScreen: true },
				options.timeout ?? this.rt.actionTimeout()
			);
			const opts = options.durationMs === undefined ? undefined : { durationMs: options.durationMs };
			this.rt.drive("longPress", await observed.driver.longPress(tapPointOf(entry), opts));
		});
	}

	/**
	 * Replaces the content of a text field: focus with the caret at the end, empty it (select all and type over the selection when
	 * the driver can, nothing for a field that is empty or shows a placeholder), type, then poll until the field holds
	 * the text on consecutive reads (the accessibility value lags the keys). A mismatch is retried once with one Backspace
	 * per character and a retype (a field that refuses select-all). Secure fields cannot be read back, so they are not
	 * verified.
	 */
	async fill(text: string, options: ActionOptions = {}): Promise<void> {
		assertOptions("fill", options, ["timeout"]);
		return this.act("fill", async () => {
			const budget = this.rt.budget(options.timeout);
			let target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			let firstHeld: string | undefined;
			for (let attempt = 1; ; attempt += 1) {
				const point = focusPoint(target.entry.element.frame);
				this.rt.drive(
					"fill",
					await focusClearType(target.observed.driver, this.pause, point, target.entry, text, clearMethodFor(attempt))
				);
				if (target.entry.secure) return;
				const outcome = await this.confirm(target, text, budget);
				if (outcome.ok) return;
				if (attempt === 2) {
					const earlier = firstHeld === undefined ? "" : ` (first attempt held ${JSON.stringify(firstHeld)})`;
					throw new E2eError(
						"ACTION_FAILED",
						`${this}: fill did not take: expected ${JSON.stringify(text)} but the field holds ${JSON.stringify(outcome.held)}${earlier}`,
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
			for (let attempt = 1; ; attempt += 1) {
				await this.focusAndClear(target, clearMethodFor(attempt));
				if (target.entry.secure) return;
				const outcome = await this.confirm(target, "", budget);
				if (outcome.ok) return;
				if (attempt === 2) {
					throw new E2eError(
						"ACTION_FAILED",
						`${this}: clear did not empty the field: it holds ${JSON.stringify(outcome.held)}`,
						outcome.screen
					);
				}
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
		const found = await this.reactCandidates(observed);
		const [match, ...others] = found;
		if (match === undefined) return { done: false, state: { kind: "none", snapshot: observed.snapshot } };
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
		budget: { remaining(): number }
	): Promise<{ ok: true } | { ok: false; held: string; screen: string | undefined }> {
		const span = Math.max(budget.remaining(), CONFIRM_FLOOR_MS);
		let lastSeen: Observed["snapshot"] | undefined;
		const readValue = (found: NodeEntry): string => (text === "" ? fieldValue(found) : rawValue(found));
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

/** What the checks after one press have seen of the screen. */
type PressWatch = {
	/** hash of the snapshot the press aimed from */
	pressedOn: string;
	started: number;
	/** some check saw a screen other than `pressedOn`: the press landed */
	changed: boolean;
	/** checks in a row that saw `pressedOn` */
	unchanged: number;
};

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

/** The first attempt empties a field the quick way; a retry means that did not work, so it presses one Backspace per character. */
function clearMethodFor(attempt: number): ClearMethod {
	return attempt === 1 ? "auto" : "counted";
}

/** What the field shows, placeholder and all (used to compare against what was typed). */
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

function scrollGaveUp(target: Locator, absent: boolean, effort: string, screen: string): E2eError {
	if (absent) return new E2eError("LOCATOR_NOT_FOUND", `${target} was not found after ${effort}`, screen);
	return new E2eError("NOT_ACTIONABLE", `${target} is still not on screen after ${effort}`, screen);
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
			if (isOnScreenEntry(entry, observed)) return;
			if (swipes >= maxSwipes || budget.remaining() <= 0) {
				throw scrollGaveUp(target, entry === undefined, `${swipes} swipes ${direction}`, rt.excerpt(observed.snapshot));
			}
			const vector = swipeVector(direction, screenRect(observed.snapshot.screen), options.momentum);
			rt.drive("scrollUntilVisible", await observed.driver.swipe(vector.from, vector.to, vector.options));
			await observed.driver.settle(SCROLL_SETTLE);
		}
	});
}
