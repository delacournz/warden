import type { DriverError, Snapshot } from "../driver/driver.types";
import { E2eError } from "../errors";
import { fieldValue } from "../screen/actions";
import { type Locator, pickOne, textOf } from "../screen/locator";
import type { NodeEntry } from "../screen/nodes";
import { resolve } from "../screen/query";
import { matchesText, normalizeText, type TextMatch } from "../screen/text";

/**
 * A negated matcher passes only after its condition held this long without a break (or the whole timeout, if shorter).
 *
 * It is not cut short when the screen settles. A snapshot carries no quiescence flag, so knowing the screen is quiet
 * takes a `driver.settle()` call per assertion: an extra round trip on iOS and a second `uiautomator dump` (~1.9 s,
 * longer than the window it would save) on Android. The wait costs no device reads beyond the polls the matcher makes
 * anyway, so it stays a plain hold.
 */
export const NEGATION_GRACE_MS = 1000;

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
		const hold = Math.min(NEGATION_GRACE_MS, timeoutMs);
		let holdingSince: number | undefined;
		type Last = { received: string; snapshot?: Snapshot };
		const result = await rt.poll<true, Last>(async (attempt) => {
			const observation = await rt.tryObserve({ reuse: attempt === 1 });
			if (!observation.ok) {
				failUnlessRetryable(observation.error);
				holdingSince = undefined;
				return { done: false, state: { received: "(screen unreadable)" } };
			}
			const { observed } = observation;
			const entries = resolve(this.locator.expr, observed.index);
			if (spec.strict && entries.length > 1) pickOne(rt, this.locator.expr, entries, observed);
			const judgement = spec.judge(entries[0], entries.length);
			const now = rt.clock.now();
			if (judgement.kind === "judged" && judgement.matches !== negate) {
				holdingSince ??= now;
				if (!negate || now - holdingSince >= hold) return { done: true, value: true };
			} else {
				holdingSince = undefined;
			}
			return {
				done: false,
				state: {
					received: judgement.kind === "missing" ? NOT_FOUND : judgement.received,
					snapshot: observed.snapshot,
				},
				...(holdingSince === undefined ? {} : { maxWaitMs: holdingSince + hold - now }),
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
