import type { Driver, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { settleByHash, snapshotHash } from "@delacour/warden-e2e/driver/settle";
import { fieldValue } from "@delacour/warden-e2e/screen/actions";
import { textOf } from "@delacour/warden-e2e/screen/locator";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "@delacour/warden-e2e/screen/nodes";
import { poll } from "@delacour/warden-e2e/screen/poll";
import { renderEntryLine } from "@delacour/warden-e2e/screen/render";
import {
	formatSelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
	pickMostSpecific,
} from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { driverUiError, type UiDeps } from "./driver";
import { type UiError, type UiErrorCode, uiError } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { type ElementJson, elementJson, storeSnapshot } from "./snapshot";

/** `wait stable` looks at the screen this often (a quiet window is judged on a fixed beat, so no back-off). */
export const POLL_MS = 100;
/** `wait stable` with no number: the screen must hold still this long. */
export const DEFAULT_STABLE_MS = 250;

const IS_STATES = ["visible", "hittable", "enabled", "checked", "selected", "focused"] as const;
export type IsState = (typeof IS_STATES)[number];
const GET_PROPS = ["text", "value", "label", "id", "role", "frame", "count"] as const;
export type GetProp = (typeof GET_PROPS)[number];

function oneOf<T extends string>(list: readonly T[], word: string | undefined): word is T {
	return list.some((item) => item === word);
}

/** The match of `selector` the query is about: `nth=` picks one, else the most specific (visible first) wins. */
export function pickEntry(index: NodeIndex, selector: ParsedSelector): NodeEntry | undefined {
	const { nth, ...rest } = selector;
	const matches = index.entries.filter((entry) => matchesSelector(entry, rest));
	return nth === undefined ? pickMostSpecific(matches, rest) : matches[nth];
}

function matchCount(index: NodeIndex, selector: ParsedSelector): number {
	const { nth: _nth, ...rest } = selector;
	return index.entries.filter((entry) => matchesSelector(entry, rest)).length;
}

type Verdict<T> = { done: true; value: T } | { done: false; reason: UiErrorCode };

type Polled<T> =
	| { hit: true; value: T; snapshot: Snapshot; waitedMs: number }
	| { hit: false; reason: UiErrorCode; waitedMs: number };

/**
 * Snapshot until `check` is satisfied or `timeoutMs` has passed (the last look is at the deadline): every 100 ms for the
 * first second, then every 250 ms. The loop and its schedule are `screen/poll.ts`'s, the ones the spec locators use.
 */
async function pollScreen<T>(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	timeoutMs: number,
	check: (index: NodeIndex) => Verdict<T>
): Promise<Result<Polled<T>, UiError>> {
	const start = ctx.now();
	type Look = { failed: UiError } | { value: T; snapshot: Snapshot };
	const result = await poll<Look, UiErrorCode>(
		async () => {
			const taken = await driver.snapshot();
			if (!taken.success) return { done: true, value: { failed: driverUiError(taken.error) } };
			const verdict = check(indexSnapshot(taken.data));
			return verdict.done
				? { done: true, value: { value: verdict.value, snapshot: taken.data } }
				: { done: false, state: verdict.reason };
		},
		{ timeoutMs, now: ctx.now, sleep: (ms) => deps.sleep(ms) }
	);
	const waitedMs = Math.max(0, ctx.now() - start);
	if (result.status === "done") {
		const look = result.value;
		if ("failed" in look) return { success: false, error: look.failed };
		return ok({ hit: true, value: look.value, snapshot: look.snapshot, waitedMs });
	}
	const reason = result.status === "timeout" ? result.last : undefined;
	return ok({ hit: false, reason: reason ?? "wait_target_absent", waitedMs });
}

function ownTexts(entry: NodeEntry): string[] {
	return [entry.name, entry.value, entry.element.text].filter((t): t is string => t !== undefined && t !== "");
}

/** The innermost visible element that shows `wanted` (substring, case-sensitive). */
export function findText(index: NodeIndex, wanted: string): NodeEntry | undefined {
	const shows = (entry: NodeEntry): boolean => entry.visible && ownTexts(entry).some((t) => t.includes(wanted));
	return index.entries.find((entry) => shows(entry) && !entry.children.some(shows));
}

export type WaitOptionValues = UiOptionValues;

type WaitPlan =
	| { mode: "visible"; selector: ParsedSelector }
	| { mode: "absent"; selector: ParsedSelector }
	| { mode: "text"; text: string }
	| { mode: "stable"; quietMs: number };

function parseWait(words: readonly string[]): Result<WaitPlan, UiError> {
	const [first, ...rest] = words;
	const usage = (message: string): Result<WaitPlan, UiError> => ({
		success: false,
		error: uiError("usage", message, { hint: 'wait <selector> | absent <selector> | text "…" | stable [ms]' }),
	});
	if (first === "stable") {
		const raw = rest[0];
		if (raw === undefined) return ok({ mode: "stable", quietMs: DEFAULT_STABLE_MS });
		if (!/^\d+$/.test(raw) || Number(raw) < 1 || rest.length > 1)
			return usage(`stable takes a number of ms, got "${rest.join(" ")}"`);
		return ok({ mode: "stable", quietMs: Number(raw) });
	}
	if (first === "text") {
		const text = rest.join(" ");
		return text === "" ? usage("wait text needs the text to wait for") : ok({ mode: "text", text });
	}
	const mode = first === "absent" ? "absent" : "visible";
	const source = (first === "absent" ? rest : words).join(" ");
	if (source.trim() === "") return usage("wait needs a selector");
	const selector = parseSelector(source);
	if (!selector.success) return usage(`bad selector: ${selector.error}`);
	return ok({ mode, selector: selector.data });
}

function visibleVerdict(selector: ParsedSelector) {
	return (index: NodeIndex): Verdict<NodeEntry> => {
		const entry = pickEntry(index, selector);
		if (entry?.visible) return { done: true, value: entry };
		return { done: false, reason: entry ? "wait_target_hidden" : "wait_target_absent" };
	};
}

function absentVerdict(selector: ParsedSelector) {
	return (index: NodeIndex): Verdict<null> => {
		const entry = pickEntry(index, selector);
		return entry?.visible ? { done: false, reason: "wait_target_present" } : { done: true, value: null };
	};
}

function textVerdict(wanted: string) {
	return (index: NodeIndex): Verdict<NodeEntry> => {
		const entry = findText(index, wanted);
		return entry ? { done: true, value: entry } : { done: false, reason: "wait_text_absent" };
	};
}

function waitFailure(plan: WaitPlan, reason: UiErrorCode, waitedMs: number): UiError {
	const what =
		plan.mode === "text"
			? `text ${JSON.stringify(plan.text)}`
			: plan.mode === "stable"
				? "a stable screen"
				: formatSelector(plan.selector);
	const messages: Partial<Record<UiErrorCode, string>> = {
		wait_target_absent: `${what} did not appear within ${waitedMs} ms`,
		wait_target_hidden: `${what} is on the tree but not visible after ${waitedMs} ms`,
		wait_target_present: `${what} still visible after ${waitedMs} ms`,
		wait_text_absent: `${what} did not appear within ${waitedMs} ms`,
		wait_not_stable: `screen kept changing for ${waitedMs} ms`,
	};
	return uiError(reason, messages[reason] ?? `${what}: ${reason}`, {
		hint: "`warden ui snapshot -i` shows what is on screen; --timeout <ms> waits longer",
		details: { matched: false, waitedMs, reason },
	});
}

/** `wait stable [ms]`: the screen hash holds for `quietMs` (poll 100 ms) within the timeout. */
async function waitStable(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	quietMs: number,
	timeoutMs: number
): Promise<Result<{ snapshot: Snapshot; waitedMs: number; quiet: boolean }, UiError>> {
	let latest: Snapshot | undefined;
	let failure: UiError | undefined;
	const poll = async (): Promise<string> => {
		const taken = await driver.snapshot();
		if (!taken.success) {
			failure = driverUiError(taken.error);
			throw new Error(taken.error.message);
		}
		latest = taken.data;
		return snapshotHash(taken.data);
	};
	try {
		const outcome = await settleByHash(poll, { quietMs, timeoutMs, now: ctx.now, sleep: deps.sleep, pollMs: POLL_MS });
		return latest ? ok({ snapshot: latest, ...outcome }) : { success: false, error: uiError("failed", "no snapshot") };
	} catch (error) {
		return {
			success: false,
			error: failure ?? uiError("failed", error instanceof Error ? error.message : String(error)),
		};
	}
}

type WaitHit = { entry?: NodeEntry; snapshot: Snapshot; waitedMs: number };

async function runWait(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	plan: WaitPlan,
	timeoutMs: number
): Promise<Result<WaitHit, UiError>> {
	if (plan.mode === "stable") {
		const stable = await waitStable(ctx, deps, driver, plan.quietMs, timeoutMs);
		if (!stable.success) return stable;
		if (!stable.data.quiet) {
			return { success: false, error: waitFailure(plan, "wait_not_stable", stable.data.waitedMs) };
		}
		return ok({ snapshot: stable.data.snapshot, waitedMs: stable.data.waitedMs });
	}
	const check =
		plan.mode === "visible"
			? visibleVerdict(plan.selector)
			: plan.mode === "text"
				? textVerdict(plan.text)
				: absentVerdict(plan.selector);
	const polled = await pollScreen<NodeEntry | null>(ctx, deps, driver, timeoutMs, check);
	if (!polled.success) return polled;
	if (!polled.data.hit) {
		return { success: false, error: waitFailure(plan, polled.data.reason, polled.data.waitedMs) };
	}
	const { value, snapshot, waitedMs } = polled.data;
	return ok({ ...(value ? { entry: value } : {}), snapshot, waitedMs });
}

/**
 * `warden ui wait <selector> | absent <selector> | text "…" | stable [ms]`: poll every 100 ms for the first second, then
 * every 250 ms (`stable` keeps 100 ms; default 5000 ms, `--timeout`)
 * until the element is visible / gone, the text shows, or the screen holds still. The screen that satisfied it is
 * stored as the next generation, so the printed `@eN` can be used straight away. A miss exits 1 with
 * `wait_target_absent` / `wait_target_hidden` / `wait_target_present` / `wait_text_absent` / `wait_not_stable`.
 */
export function uiWait(ctx: CommandContext, deps: UiDeps, words: string[], opts: WaitOptionValues): Promise<number> {
	return runUi(ctx, deps, "wait", opts, async (device, env) => {
		const plan = parseWait(words);
		if (!plan.success) return plan;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const hit = await runWait(ctx, deps, driver.data, plan.data, env.timeoutMs);
		if (!hit.success) return hit;
		const { entry, snapshot, waitedMs } = hit.data;
		const { generation, refs } = storeSnapshot(ctx, device.udid, snapshot);
		const ref = entry ? refs.byId.get(entry.element.id) : undefined;
		const line = entry ? renderEntryLine(entry, ref === undefined ? {} : { ref }) : undefined;
		const element: ElementJson | undefined = entry ? elementJson(entry, ref) : undefined;
		const text =
			line !== undefined
				? `waited ${waitedMs} ms: ${line}`
				: plan.data.mode === "stable"
					? `stable after ${waitedMs} ms`
					: `gone after ${waitedMs} ms`;
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			generation,
			result: { matched: true, ...(ref !== undefined ? { ref } : {}), ...(element ? { element } : {}), waitedMs },
			text,
		});
	});
}

function isState(entry: NodeEntry, state: IsState): boolean {
	switch (state) {
		case "visible":
			return entry.visible;
		case "hittable":
			return entry.element.hittable === true;
		case "enabled":
			return !entry.states.disabled;
		case "checked":
			return entry.states.checked === true;
		case "selected":
			return entry.states.selected;
		case "focused":
			return entry.states.focused;
	}
}

/** Split `<selector…> <word>`: the last word names the state / property. */
function splitLast(words: readonly string[]): { selector: string; last: string | undefined } {
	return { selector: words.slice(0, -1).join(" "), last: words[words.length - 1] };
}

function parseQuerySelector(source: string, usage: string): Result<ParsedSelector, UiError> {
	if (source.trim() === "") return { success: false, error: uiError("usage", usage) };
	const parsed = parseSelector(source);
	if (!parsed.success) return { success: false, error: uiError("usage", `bad selector: ${parsed.error}`) };
	return ok(parsed.data);
}

/**
 * `warden ui is <selector…> visible|hittable|enabled|checked|selected|focused`: one look at the screen. Exit 0 when
 * true, 1 when false (also when nothing matches); only an engine failure exits higher. `--json` prints
 * `{ matched, state, element?, waitedMs, reason? }` either way.
 */
export function uiIs(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "is", opts, async (device, env) => {
		const { selector: source, last: state } = splitLast(words);
		const usage = `is needs a selector and a state: ${IS_STATES.join("|")}`;
		if (!oneOf(IS_STATES, state)) return { success: false, error: uiError("usage", usage) };
		const selector = parseQuerySelector(source, usage);
		if (!selector.success) return selector;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const start = ctx.now();
		const taken = await driver.data.snapshot();
		if (!taken.success) return { success: false, error: driverUiError(taken.error) };
		const entry = pickEntry(indexSnapshot(taken.data), selector.data);
		const matched = entry !== undefined && isState(entry, state);
		const reason = entry === undefined ? "target_absent" : matched ? undefined : `not_${state}`;
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: {
				matched,
				state,
				...(entry ? { element: elementJson(entry, undefined) } : {}),
				waitedMs: Math.max(0, ctx.now() - start),
				...(reason !== undefined ? { reason } : {}),
			},
			text: matched ? "true" : "false",
			...(matched ? {} : { exit: 1 as const }),
		});
	});
}

function frameText(entry: NodeEntry): string {
	const { x, y, width, height } = entry.element.frame;
	return `${x} ${y} ${width} ${height}`;
}

function propertyOf(
	entry: NodeEntry,
	prop: Exclude<GetProp, "count">
): string | { x: number; y: number; width: number; height: number } {
	switch (prop) {
		case "text":
			return textOf(entry);
		case "value":
			return entry.role === "textbox" || entry.role === "searchbox" ? fieldValue(entry) : (entry.value ?? "");
		case "label":
			return entry.element.label ?? "";
		case "id":
			return entry.element.identifier ?? "";
		case "role":
			return entry.role;
		case "frame":
			return entry.element.frame;
	}
}

/**
 * `warden ui get <selector…> text|value|label|id|role|frame|count`: print one property of the element (stdout is the
 * bare value, `frame` is `x y w h`). `count` is how many elements match (0 is fine); the others need a match
 * (`target_not_found` exit 1).
 */
export function uiGet(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "get", opts, async (device, env) => {
		const { selector: source, last: prop } = splitLast(words);
		const usage = `get needs a selector and a property: ${GET_PROPS.join("|")}`;
		if (!oneOf(GET_PROPS, prop)) return { success: false, error: uiError("usage", usage) };
		const selector = parseQuerySelector(source, usage);
		if (!selector.success) return selector;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const start = ctx.now();
		const taken = await driver.data.snapshot();
		if (!taken.success) return { success: false, error: driverUiError(taken.error) };
		const index = indexSnapshot(taken.data);
		const info = { udid: device.udid, platform: device.platform, name: device.name };
		const waitedMs = () => Math.max(0, ctx.now() - start);
		if (prop === "count") {
			const count = matchCount(index, selector.data);
			return ok({
				device: info,
				result: { matched: count > 0, property: "count", value: count, waitedMs: waitedMs() },
				text: String(count),
			});
		}
		const entry = pickEntry(index, selector.data);
		if (!entry) {
			return {
				success: false,
				error: uiError("target_not_found", `${formatSelector(selector.data)} matched nothing`, {
					hint: "run `warden ui snapshot -i` to see what is on screen",
				}),
			};
		}
		const value = propertyOf(entry, prop);
		return ok({
			device: info,
			result: {
				matched: true,
				property: prop,
				value,
				element: elementJson(entry, undefined),
				waitedMs: waitedMs(),
			},
			text: typeof value === "string" ? value : frameText(entry),
		});
	});
}
