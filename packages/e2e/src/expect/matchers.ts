import type { Driver, DriverError, Snapshot } from "../driver/driver.types";
import { canObserve } from "../driver/observation-cache";
import { E2eError } from "../errors";
import { fieldValue } from "../screen/actions";
import { type Locator, pickOne, textOf } from "../screen/locator";
import type { NodeEntry } from "../screen/nodes";
import { resolve } from "../screen/query";
import { matchesText, normalizeText, type TextMatch } from "../screen/text";

/**
 * A negated matcher passes only after its condition held this long without a break (or the whole timeout, if shorter).
 *
 * It can end sooner: once the condition held on one poll, a driver with native settle (iOS `axbridge`, Android
 * `warden-uiad`: both watch the app's own activity stream, ~250-300 ms) is asked once whether the screen is quiet
 * (`NEGATION_QUIET_MS`, bounded by what is left of the hold). If it is, one fresh poll that still holds passes. A screen
 * that is quiet but about to change by itself (a toast after a timer) can therefore pass before that change, where the
 * full hold would have seen it. Without native settle the hold stays plain: there, knowing the screen is quiet means
 * polled snapshots or a `uiautomator dump` (~1.9 s), longer than the window it would save.
 *
 * The settle is asked only when no input came within the last `NEGATION_GRACE_MS` (the observation cache's
 * `sinceInputMs`; no input yet counts as none). A quiet app is not a settled one right after a tap: a submit waiting on
 * the network is idle until the reply comes, so `submit.tap()` then `expect(error).not.toBeVisible()` keeps the full
 * hold, which sees an error that comes within it. Without the cache the time of the last input is unknown: plain hold.
 * Input is every driver call that is not a read, the matcher's own native settle included (so a second `.not` right
 * after one that ended early holds the full time). Devtools calls (`device.devtools.evaluate`, `reloadJs`) go to Metro,
 * not the driver, so they do not count: a `.not` right after one may end early. Tap, `wait` or assert something
 * positive first.
 */
export const NEGATION_GRACE_MS = 1000;
/** The quiet window a negated matcher asks the driver for before it ends its hold early. */
export const NEGATION_QUIET_MS = 250;

export type AssertionOptions = { timeout?: number };
export type TextAssertionOptions = AssertionOptions & { exact?: boolean };
export type ContainAssertionOptions = AssertionOptions & { ignoreCase?: boolean };
export type CheckedOptions = AssertionOptions & { checked?: boolean };

export type AssertionContext = {
	negate: boolean;
	/** collects a failure instead of throwing it (`expect.soft`) */
	soft?: (error: E2eError) => void;
};

/** What one read of the screen says about a matcher's condition. */
type Judgement = { kind: "missing" } | { kind: "judged"; matches: boolean; received: string };

type Spec = {
	/** `toHaveText("a")`: the call as it appears in messages and step labels */
	call: string;
	/** what the condition expects, without a `not` */
	expected: string;
	/** everything but `toHaveCount` needs exactly one match */
	strict: boolean;
	judge(entry: NodeEntry | undefined, count: number): Judgement;
};

const NOT_FOUND = "element not found";

function missing(): Judgement {
	return { kind: "missing" };
}

function judged(matches: boolean, received: string): Judgement {
	return { kind: "judged", matches, received };
}

function show(match: TextMatch): string {
	return typeof match === "string" ? JSON.stringify(match) : String(match);
}

function assertOptions(matcher: string, options: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new E2eError(
			"INVALID_ARGUMENT",
			`${matcher} does not take ${unknown.map((key) => `"${key}"`).join(", ")}; it takes ${allowed.join(", ")}`
		);
	}
	const bag = options;
	for (const key of ["checked", "exact", "ignoreCase"]) {
		if (bag[key] !== undefined && typeof bag[key] !== "boolean") {
			throw new E2eError("INVALID_ARGUMENT", `${matcher}: "${key}" must be a boolean`);
		}
	}
	const timeout = bag.timeout;
	if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) {
		throw new E2eError("INVALID_ARGUMENT", `${matcher}: "timeout" must be a non-negative number of milliseconds`);
	}
}

function failUnlessRetryable(error: DriverError): void {
	if (!error.retryable) throw new E2eError("DRIVER", `snapshot failed: ${error.code}: ${error.message}`);
}

function regexTest(pattern: RegExp, value: string, ignoreCase = false): boolean {
	const flags = pattern.flags.replaceAll(/[gy]/g, "");
	return new RegExp(pattern.source, ignoreCase && !flags.includes("i") ? `${flags}i` : flags).test(value);
}

function containsText(value: string, expected: TextMatch, ignoreCase: boolean): boolean {
	if (typeof expected !== "string") return regexTest(expected, normalizeText(value), ignoreCase);
	const haystack = normalizeText(value);
	const needle = normalizeText(expected);
	return ignoreCase ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

/**
 * The locator matchers of `expect(locator)`. Each one polls (100 ms apart for the first second, then 250 ms) until its
 * condition holds or the assertion timeout passes, then fails with `ASSERTION`. `.not` inverts the condition (and must
 * see it hold for a grace window; the polls land exactly on its end).
 * Except `toHaveCount`, a matcher needs exactly one match: none keeps polling, several fail at once.
 */
export class LocatorAssertions {
	constructor(
		private readonly locator: Locator,
		private readonly context: AssertionContext
	) {}

	get not(): LocatorAssertions {
		return new LocatorAssertions(this.locator, { ...this.context, negate: !this.context.negate });
	}

	async toBeVisible(options: AssertionOptions = {}): Promise<void> {
		assertOptions("toBeVisible", options, ["timeout"]);
		return this.assert(
			{
				call: "toBeVisible()",
				expected: "visible",
				strict: true,
				judge: (entry) =>
					entry === undefined
						? judged(false, "not found")
						: judged(entry.visible, entry.visible ? "visible" : "hidden"),
			},
			options
		);
	}

	async toBeHidden(options: AssertionOptions = {}): Promise<void> {
		assertOptions("toBeHidden", options, ["timeout"]);
		return this.assert(
			{
				call: "toBeHidden()",
				expected: "hidden",
				strict: true,
				judge: (entry) =>
					entry === undefined
						? judged(true, "not found")
						: judged(!entry.visible, entry.visible ? "visible" : "hidden"),
			},
			options
		);
	}

	/** Whole-text after whitespace normalisation (`exact: false`: a case-insensitive substring); a RegExp as written. */
	async toHaveText(expected: TextMatch, options: TextAssertionOptions = {}): Promise<void> {
		assertOptions("toHaveText", options, ["exact", "timeout"]);
		const exact = options.exact ?? true;
		return this.assert(
			{
				call: `toHaveText(${show(expected)})`,
				expected: exact ? show(expected) : `${show(expected)} (substring, ignoring case)`,
				strict: true,
				judge: (entry) => {
					if (entry === undefined) return missing();
					const value = textOf(entry);
					return judged(matchesText(value, expected, { exact }), JSON.stringify(value));
				},
			},
			options
		);
	}

	/** The (normalised) text contains the string, case-sensitively unless `ignoreCase`; a RegExp is tested as written. */
	async toContainText(expected: TextMatch, options: ContainAssertionOptions = {}): Promise<void> {
		assertOptions("toContainText", options, ["ignoreCase", "timeout"]);
		const ignoreCase = options.ignoreCase ?? false;
		return this.assert(
			{
				call: `toContainText(${show(expected)})`,
				expected: `text containing ${show(expected)}`,
				strict: true,
				judge: (entry) => {
					if (entry === undefined) return missing();
					const value = textOf(entry);
					return judged(containsText(value, expected, ignoreCase), JSON.stringify(value));
				},
			},
			options
		);
	}

	/** The field value as it is (no whitespace normalisation). Secure fields cannot be judged. */
	async toHaveValue(expected: TextMatch, options: AssertionOptions = {}): Promise<void> {
		assertOptions("toHaveValue", options, ["timeout"]);
		return this.assert(
			{
				call: `toHaveValue(${show(expected)})`,
				expected: show(expected),
				strict: true,
				judge: (entry) => {
					if (entry === undefined) return missing();
					if (entry.secure) {
						throw new E2eError(
							"INVALID_ARGUMENT",
							"toHaveValue cannot judge a secure field: its value is withheld. Assert the outcome of the fill instead."
						);
					}
					const value = fieldValue(entry);
					const matches = typeof expected === "string" ? value === expected : regexTest(expected, value);
					return judged(matches, JSON.stringify(value));
				},
			},
			options
		);
	}

	/** Checked by default; `{ checked: false }` expects unchecked. A node that is not checkable counts as unchecked. */
	async toBeChecked(options: CheckedOptions = {}): Promise<void> {
		assertOptions("toBeChecked", options, ["checked", "timeout"]);
		const want = options.checked ?? true;
		return this.assert(
			{
				call: options.checked === undefined ? "toBeChecked()" : `toBeChecked({ checked: ${want} })`,
				expected: want ? "checked" : "unchecked",
				strict: true,
				judge: (entry) => {
					if (entry === undefined) return missing();
					const checked = entry.states.checked ?? false;
					return judged(checked === want, checked ? "checked" : "unchecked");
				},
			},
			options
		);
	}

	async toBeEnabled(options: AssertionOptions = {}): Promise<void> {
		assertOptions("toBeEnabled", options, ["timeout"]);
		return this.assert(
			{
				call: "toBeEnabled()",
				expected: "enabled",
				strict: true,
				judge: (entry) =>
					entry === undefined
						? missing()
						: judged(!entry.states.disabled, entry.states.disabled ? "disabled" : "enabled"),
			},
			options
		);
	}

	async toBeDisabled(options: AssertionOptions = {}): Promise<void> {
		assertOptions("toBeDisabled", options, ["timeout"]);
		return this.assert(
			{
				call: "toBeDisabled()",
				expected: "disabled",
				strict: true,
				judge: (entry) =>
					entry === undefined
						? missing()
						: judged(entry.states.disabled, entry.states.disabled ? "disabled" : "enabled"),
			},
			options
		);
	}

	/** Exactly `expected` current matches (zero included). */
	async toHaveCount(expected: number, options: AssertionOptions = {}): Promise<void> {
		assertOptions("toHaveCount", options, ["timeout"]);
		if (!Number.isInteger(expected) || expected < 0) {
			throw new E2eError("INVALID_ARGUMENT", `toHaveCount takes a non-negative integer, got ${String(expected)}`);
		}
		return this.assert(
			{
				call: `toHaveCount(${expected})`,
				expected: String(expected),
				strict: false,
				judge: (_entry, count) => judged(count === expected, String(count)),
			},
			options
		);
	}

	private async assert(spec: Spec, options: AssertionOptions): Promise<void> {
		const rt = this.locator.runtime;
		const timeoutMs = options.timeout ?? rt.assertionTimeout();
		try {
			await rt.step(`expect ${this.locator}.${spec.call}`, () => this.poll(spec, timeoutMs));
		} catch (error) {
			// an aborted attempt (its deadline) is never softened; only the assertion's own failures are
			if (this.context.soft !== undefined && error instanceof E2eError && error.code !== "TIMEOUT") {
				this.context.soft(error);
				return;
			}
			throw error;
		}
	}

	private async poll(spec: Spec, timeoutMs: number): Promise<void> {
		const rt = this.locator.runtime;
		const { negate } = this.context;
		const hold = conditionHold(negate, Math.min(NEGATION_GRACE_MS, timeoutMs), rt.clock.now);
		type Last = { received: string; snapshot?: Snapshot };
		const result = await rt.poll<true, Last>(async (attempt) => {
			const observation = await rt.tryObserve({ reuse: attempt === 1 });
			if (!observation.ok) {
				failUnlessRetryable(observation.error);
				hold.broken();
				return { done: false, state: { received: "(screen unreadable)" } };
			}
			const { observed } = observation;
			const entries = resolve(this.locator.expr, observed.index);
			if (spec.strict && entries.length > 1) pickOne(rt, this.locator.expr, entries, observed);
			const judgement = spec.judge(entries[0], entries.length);
			const verdict = await hold.next(judgement.kind === "judged" && judgement.matches !== negate, observed.driver);
			if (verdict === "pass") return { done: true, value: true };
			return {
				done: false,
				state: {
					received: judgement.kind === "missing" ? NOT_FOUND : judgement.received,
					snapshot: observed.snapshot,
				},
				...(verdict.wakeMs === undefined ? {} : { maxWaitMs: verdict.wakeMs }),
			};
		}, timeoutMs);
		if (result.status === "done") return;
		throw this.failure(spec, result.last);
	}

	/** The screen is rendered here, from the last snapshot read, because only a failure needs the text. */
	private failure(spec: Spec, last: { received: string; snapshot?: Snapshot } | undefined): E2eError {
		const { negate } = this.context;
		const lines = [
			`expect(${this.locator})${negate ? ".not" : ""}.${spec.call}`,
			`Expected: ${negate ? "not " : ""}${spec.expected}`,
			`Received: ${last?.received ?? NOT_FOUND}`,
		];
		const screen = last?.snapshot === undefined ? undefined : this.locator.runtime.excerpt(last.snapshot);
		const message = screen === undefined ? lines.join("\n") : `${lines.join("\n")}\n\n${screen}`;
		return new E2eError("ASSERTION", message, screen);
	}
}

/** What one poll means for a matcher: it passes, or poll again, waking within `wakeMs` when a hold is running. */
type HoldVerdict = "pass" | { wakeMs: number | undefined };

/**
 * The hold of a matcher's condition. A positive matcher passes on the first poll that holds. A negated one passes once
 * the condition held `holdMs` without a break, or, on a driver with native settle, on the first poll that still holds
 * after the one settle it asks for (at the first poll that held, with no input in the last `NEGATION_GRACE_MS`)
 * reported quiet.
 */
function conditionHold(
	negate: boolean,
	holdMs: number,
	now: () => number
): { next(holds: boolean, driver: Driver): Promise<HoldVerdict>; broken(): void } {
	let since: number | undefined;
	let asked = false;
	/** the settle reported quiet during the current hold */
	let quiet = false;
	const broken = (): void => {
		since = undefined;
		quiet = false;
	};
	return {
		broken,
		async next(holds, driver) {
			if (!holds) {
				broken();
				return { wakeMs: undefined };
			}
			since ??= now();
			if (!negate || quiet || now() - since >= holdMs) return "pass";
			if (!asked && driver.capabilities.nativeSettle && noRecentInput(driver)) {
				asked = true;
				quiet = await settledQuiet(driver, since + holdMs - now());
			}
			return { wakeMs: quiet ? 0 : since + holdMs - now() };
		},
	};
}

/** Whether the observation cache in front of `driver` says no input came within the last `NEGATION_GRACE_MS`. */
function noRecentInput(driver: Driver): boolean {
	const previous = canObserve(driver) ? driver.previous?.() : undefined;
	if (previous === undefined) return false;
	return previous.sinceInputMs === undefined || previous.sinceInputMs >= NEGATION_GRACE_MS;
}

/** Whether `driver` says the screen went quiet within `timeoutMs`; a failure or a deadline is "cannot tell". */
async function settledQuiet(driver: Driver, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const settled = await driver.settle({ quietMs: NEGATION_QUIET_MS, timeoutMs });
	return settled.success && settled.data.quiet;
}
