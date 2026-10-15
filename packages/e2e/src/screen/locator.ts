import type { KeyName, Modifier, Point, Rect } from "../driver/driver.types";
import { E2eError } from "../errors";
import {
	clearKeyPresses,
	fieldValue,
	focusPoint,
	isOnScreen,
	type Momentum,
	type SwipeDirection,
	screenRect,
	swipeVector,
	tapPointOf,
	visibleRect,
} from "./actions";
import type { Observed, Runtime } from "./context";
import type { NodeEntry } from "./nodes";
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
import type { QueryRole } from "./roles";
import { normalizeText, type TextMatch } from "./text";

export type ActionOptions = { timeout?: number };
export type TapOptions = ActionOptions & { position?: Point };
export type LongPressOptions = ActionOptions & { durationMs?: number };
export type PressOptions = ActionOptions & { modifiers?: readonly Modifier[] };
export type LocatorSwipeOptions = ActionOptions & { direction: SwipeDirection; momentum?: Momentum };
export type ScrollOptions = ActionOptions & { direction?: SwipeDirection; momentum?: Momentum; maxSwipes?: number };
export type WaitState = "attached" | "detached" | "visible" | "hidden";
export type WaitForOptions = ActionOptions & { state?: WaitState };

const WAIT_STATES: readonly WaitState[] = ["attached", "detached", "visible", "hidden"];
const DEFAULT_MAX_SWIPES = 10;
/** How long `fill` waits for the field to show what was typed. */
const VERIFY_MS = 1000;
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
	| { kind: "driver"; message: string };

type Actionable = { entry: NodeEntry; observed: Observed };

type ActionSpec = {
	/** refuse disabled elements */
	enabled: boolean;
	/** refuse elements whose tap point is off screen */
	tapPointOnScreen: boolean;
};

export class Locator {
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

	private async matches(): Promise<{ entries: NodeEntry[]; observed: Observed }> {
		const observed = await this.rt.observe();
		return { entries: resolve(this.expr, observed.index), observed };
	}

	private async single(): Promise<{ entry: NodeEntry; observed: Observed }> {
		const { entries, observed } = await this.matches();
		return { entry: this.exactlyOne(entries, observed), observed };
	}

	private exactlyOne(entries: readonly NodeEntry[], observed: Observed): NodeEntry {
		return pickOne(this.rt, this.expr, entries, observed);
	}

	async count(): Promise<number> {
		return (await this.matches()).entries.length;
	}

	async all(): Promise<Locator[]> {
		const count = await this.count();
		return Array.from({ length: count }, (_, index) => this.nth(index));
	}

	async text(): Promise<string> {
		return textOf((await this.single()).entry);
	}

	async allTexts(): Promise<string[]> {
		return (await this.matches()).entries.map(textOf);
	}

	async value(): Promise<string> {
		return fieldValue((await this.single()).entry);
	}

	async isVisible(): Promise<boolean> {
		const { entries, observed } = await this.matches();
		if (entries.length === 0) return false;
		return this.exactlyOne(entries, observed).visible;
	}

	async isHidden(): Promise<boolean> {
		return !(await this.isVisible());
	}

	async isEnabled(): Promise<boolean> {
		return !(await this.single()).entry.states.disabled;
	}

	async isChecked(): Promise<boolean> {
		return (await this.single()).entry.states.checked === true;
	}

	async boundingBox(): Promise<Rect> {
		return { ...(await this.single()).entry.element.frame };
	}

	/** Polls until the locator is `visible` (default), `hidden`, `attached` or `detached`; else `TIMEOUT`. */
	async waitFor(options: WaitForOptions = {}): Promise<void> {
		assertOptions("waitFor", options, ["state", "timeout"]);
		const state = options.state ?? "visible";
		if (!WAIT_STATES.includes(state)) {
			throw new E2eError(
				"INVALID_ARGUMENT",
				`waitFor state must be one of ${WAIT_STATES.join(", ")}, got "${String(state)}"`
			);
		}
		const timeoutMs = options.timeout ?? this.rt.actionTimeout();
		const result = await this.rt.poll<true, Observed["snapshot"] | undefined>(async () => {
			const observation = await this.rt.tryObserve();
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

	private act<T>(verb: string, run: () => Promise<T>): Promise<T> {
		return this.rt.step(`${verb} ${this}`, run);
	}

	/** Waits for exactly one visible (and, per `spec`, enabled, on-screen) match. Several matches fail at once. */
	private async actionable(spec: ActionSpec, timeoutMs: number): Promise<Actionable> {
		const result = await this.rt.poll<Actionable, Seen>(async () => {
			const observation = await this.rt.tryObserve();
			if (!observation.ok) {
				if (!observation.error.retryable) {
					throw new E2eError("DRIVER", `snapshot failed: ${observation.error.code}: ${observation.error.message}`);
				}
				return { done: false, state: { kind: "driver", message: observation.error.message } };
			}
			const { observed } = observation;
			const entries = resolve(this.expr, observed.index);
			if (entries.length === 0) return { done: false, state: { kind: "none", snapshot: observed.snapshot } };
			const entry = this.exactlyOne(entries, observed);
			const reason = blockedReason(entry, spec, observed);
			if (reason !== undefined) return { done: false, state: { kind: "blocked", reason, snapshot: observed.snapshot } };
			return { done: true, value: { entry, observed } };
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
		if (seen?.kind === "driver") throw new E2eError("DRIVER", `snapshot kept failing: ${seen.message}`);
		throw new E2eError(
			"LOCATOR_NOT_FOUND",
			`${this} matched no elements within ${timeoutMs} ms`,
			seen === undefined ? undefined : this.rt.excerpt(seen.snapshot)
		);
	}

	async tap(options: TapOptions = {}): Promise<void> {
		assertOptions("tap", options, ["position", "timeout"]);
		return this.act("tap", async () => {
			const withPosition = options.position !== undefined;
			const { entry, observed } = await this.actionable(
				{ enabled: !withPosition, tapPointOnScreen: !withPosition },
				options.timeout ?? this.rt.actionTimeout()
			);
			this.rt.drive("tap", await observed.driver.tap(tapPointOf(entry, options.position)));
		});
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
	 * Replaces the content of a text field: focus with the caret at the end, backspace what is there, type, then check
	 * the field shows the text (retrying once). Secure fields cannot be read back, so they are not verified.
	 */
	async fill(text: string, options: ActionOptions = {}): Promise<void> {
		assertOptions("fill", options, ["timeout"]);
		return this.act("fill", async () => {
			const budget = this.rt.budget(options.timeout);
			let target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			for (let attempt = 1; ; attempt += 1) {
				await this.focusAndClear(target);
				if (text !== "") this.rt.drive("fill", await target.observed.driver.typeText(text));
				if (target.entry.secure) return;
				const held = await this.verify(text, Math.min(VERIFY_MS, budget.remaining()));
				if (held.ok) return;
				if (attempt === 2) {
					throw new E2eError(
						"ACTION_FAILED",
						`${this}: fill did not take: expected ${JSON.stringify(text)} but the field holds ${JSON.stringify(held.value)}`,
						held.screen
					);
				}
				target = await this.actionable({ enabled: true, tapPointOnScreen: false }, budget.remaining());
			}
		});
	}

	async clear(options: ActionOptions = {}): Promise<void> {
		assertOptions("clear", options, ["timeout"]);
		return this.act("clear", async () => {
			const target = await this.actionable(
				{ enabled: true, tapPointOnScreen: false },
				options.timeout ?? this.rt.actionTimeout()
			);
			await this.focusAndClear(target);
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
			this.rt.drive("type", await target.observed.driver.typeText(text));
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

	/** Scrolls the screen until this locator is on screen. */
	scrollTo(options: ScrollOptions = {}): Promise<void> {
		return scrollUntilVisible(this.rt, this, options);
	}

	private async focus({ entry, observed }: Actionable): Promise<void> {
		if (entry.states.focused) return;
		this.rt.drive("focus", await observed.driver.tap(focusPoint(entry.element.frame)));
	}

	private async focusAndClear({ entry, observed }: Actionable): Promise<void> {
		this.rt.drive("focus", await observed.driver.tap(focusPoint(entry.element.frame)));
		const presses = clearKeyPresses(entry);
		for (let press = 0; press < presses; press += 1) {
			this.rt.drive("clear", await observed.driver.key("Backspace"));
		}
	}

	/** Polls (briefly) until the single match holds `text`; otherwise reports what it holds. */
	private async verify(
		text: string,
		timeoutMs: number
	): Promise<{ ok: true } | { ok: false; value: string; screen: string | undefined }> {
		const result = await this.rt.poll<true, { value: string; screen: string | undefined }>(async () => {
			const observation = await this.rt.tryObserve();
			if (!observation.ok) return { done: false, state: { value: "(unreadable)", screen: undefined } };
			const entries = resolve(this.expr, observation.observed.index);
			const screen = this.rt.excerpt(observation.observed.snapshot);
			const [entry] = entries;
			if (entries.length !== 1 || entry === undefined) {
				return { done: false, state: { value: `(${entries.length} matches)`, screen } };
			}
			const held = rawValue(entry);
			const same = text === "" ? fieldValue(entry) === "" : held === text;
			return same ? { done: true, value: true } : { done: false, state: { value: held, screen } };
		}, timeoutMs);
		if (result.status === "done") return { ok: true };
		return { ok: false, value: result.last?.value ?? "", screen: result.last?.screen };
	}
}

/** The strict one-match rule; the error carries the rendered screen. */
function pickOne(rt: Runtime, expr: LocatorExpression, entries: readonly NodeEntry[], observed: Observed): NodeEntry {
	const result = exactlyOne(expr, entries, { screen: rt.excerpt(observed.snapshot) });
	if (!result.success) throw result.error;
	return result.data;
}

/** Display text: the accessible name, else the text of everything inside. */
function textOf(entry: NodeEntry): string {
	return normalizeText(entry.name ?? "") || entry.subtreeText;
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
