import type { Driver, Rect, Snapshot } from "@delacour/warden-driver/driver.types";
import { settler } from "@delacour/warden-driver/settle";
import { fieldValue } from "@delacour/warden-screen/actions";
import { textOf } from "@delacour/warden-screen/locator";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "@delacour/warden-screen/nodes";
import { poll } from "@delacour/warden-screen/poll";
import { renderEntryLine } from "@delacour/warden-screen/render";
import {
	formatSelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
	pickMostSpecific,
} from "@delacour/warden-screen/selector";
import type { WardenError, WardenErrorCode } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { recordTarget } from "./act";
import { driverError, fail, opError } from "./errors";
import { evidenceOf, type RecordStep } from "./record";
import type { OpOutcome, OpSession } from "./session";
import { type ElementJson, elementJson, storeSnapshot } from "./snapshot";

/** `wait stable` looks at the screen this often (a quiet window is judged on a fixed beat, so no back-off). */
export const POLL_MS = 100;
/** `wait stable` with no number: the screen must hold still this long. */
export const DEFAULT_STABLE_MS = 250;

export const IS_STATES = ["visible", "hittable", "enabled", "checked", "selected", "focused"] as const;
export type IsState = (typeof IS_STATES)[number];
export const GET_PROPS = ["text", "value", "label", "id", "role", "frame", "count"] as const;
export type GetProp = (typeof GET_PROPS)[number];

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

type Verdict<T> = { done: true; value: T } | { done: false; reason: WardenErrorCode };

type Polled<T> =
	| { hit: true; value: T; snapshot: Snapshot; waitedMs: number }
	| { hit: false; reason: WardenErrorCode; waitedMs: number };

/**
 * Snapshot until `check` is satisfied or `timeoutMs` has passed (the last look is at the deadline): every 100 ms for the
 * first second, then every 250 ms. The loop and its schedule are `screen/poll.ts`'s, the ones the spec locators use.
 */
async function pollScreen<T>(
	session: OpSession,
	driver: Driver,
	timeoutMs: number,
	check: (index: NodeIndex) => Verdict<T>
): Promise<Result<Polled<T>, WardenError>> {
	const start = session.host.now();
	type Look = { failed: WardenError } | { value: T; snapshot: Snapshot };
	const result = await poll<Look, WardenErrorCode>(
		async () => {
			const taken = await driver.snapshot();
			if (!taken.success) return { done: true, value: { failed: driverError(taken.error) } };
			const verdict = check(indexSnapshot(taken.data));
			return verdict.done
				? { done: true, value: { value: verdict.value, snapshot: taken.data } }
				: { done: false, state: verdict.reason };
		},
		{ timeoutMs, now: session.host.now, sleep: (ms) => session.host.sleep(ms) }
	);
	const waitedMs = Math.max(0, session.host.now() - start);
	if (result.status === "done") {
		const look = result.value;
		if ("failed" in look) return fail(look.failed);
		return resultFactory.ok({ hit: true, value: look.value, snapshot: look.snapshot, waitedMs });
	}
	const reason = result.status === "timeout" ? result.last : undefined;
	return resultFactory.ok({ hit: false, reason: reason ?? "wait_target_absent", waitedMs });
}

function ownTexts(entry: NodeEntry): string[] {
	return [entry.name, entry.value, entry.element.text].filter((t): t is string => t !== undefined && t !== "");
}

/** The innermost visible element that shows `wanted` (substring, case-sensitive). */
export function findText(index: NodeIndex, wanted: string): NodeEntry | undefined {
	const shows = (entry: NodeEntry): boolean => entry.visible && ownTexts(entry).some((t) => t.includes(wanted));
	return index.entries.find((entry) => shows(entry) && !entry.children.some(shows));
}

/** What to wait for. */
export type WaitParams =
	| { mode: "visible"; selector: string }
	| { mode: "absent"; selector: string }
	| { mode: "text"; text: string }
	| { mode: "stable"; quietMs?: number };

export type WaitResult = {
	matched: true;
	ref?: string;
	element?: ElementJson;
	waitedMs: number;
};

type WaitPlan =
	| { mode: "visible"; selector: ParsedSelector }
	| { mode: "absent"; selector: ParsedSelector }
	| { mode: "text"; text: string }
	| { mode: "stable"; quietMs: number };

const WAIT_HINT = 'wait <selector> | absent <selector> | text "…" | stable [ms]';

function planOf(params: WaitParams): Result<WaitPlan, WardenError> {
	if (params.mode === "stable")
		return resultFactory.ok({ mode: "stable", quietMs: params.quietMs ?? DEFAULT_STABLE_MS });
	if (params.mode === "text") return resultFactory.ok({ mode: "text", text: params.text });
	const selector = parseSelector(params.selector);
	if (!selector.success) {
		return fail(opError("usage", `bad selector: ${selector.error}`, { hint: WAIT_HINT }));
	}
	return resultFactory.ok({ mode: params.mode, selector: selector.data });
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

function waitFailure(plan: WaitPlan, reason: WardenErrorCode, waitedMs: number): WardenError {
	const what =
		plan.mode === "text"
			? `text ${JSON.stringify(plan.text)}`
			: plan.mode === "stable"
				? "a stable screen"
				: formatSelector(plan.selector);
	const messages: Partial<Record<WardenErrorCode, string>> = {
		wait_target_absent: `${what} did not appear within ${waitedMs} ms`,
		wait_target_hidden: `${what} is on the tree but not visible after ${waitedMs} ms`,
		wait_target_present: `${what} still visible after ${waitedMs} ms`,
		wait_text_absent: `${what} did not appear within ${waitedMs} ms`,
		wait_not_stable: `screen kept changing for ${waitedMs} ms`,
	};
	return opError(reason, messages[reason] ?? `${what}: ${reason}`, {
		hint: "`warden ui snapshot -i` shows what is on screen; --timeout <ms> waits longer",
		details: { matched: false, waitedMs, reason },
	});
}

/** `wait stable [ms]`: the screen hash holds for `quietMs` (poll 100 ms) within the timeout. */
async function waitStable(
	session: OpSession,
	driver: Driver,
	quietMs: number,
	timeoutMs: number
): Promise<Result<{ snapshot: Snapshot; waitedMs: number; quiet: boolean }, WardenError>> {
	let latest: Snapshot | undefined;
	let failure: WardenError | undefined;
	const look = async (): Promise<string> => {
		const taken = await driver.snapshot();
		if (!taken.success) {
			failure = driverError(taken.error);
			throw new Error(taken.error.message);
		}
		latest = taken.data;
		return settler.snapshotHash(taken.data);
	};
	try {
		const outcome = await settler.byHash(look, {
			quietMs,
			timeoutMs,
			now: session.host.now,
			sleep: session.host.sleep,
			pollMs: POLL_MS,
		});
		return latest ? resultFactory.ok({ snapshot: latest, ...outcome }) : fail(opError("failed", "no snapshot"));
	} catch (error) {
		return fail(failure ?? opError("failed", error instanceof Error ? error.message : String(error)));
	}
}

type WaitHit = { entry?: NodeEntry; snapshot: Snapshot; waitedMs: number };

async function runWait(session: OpSession, driver: Driver, plan: WaitPlan): Promise<Result<WaitHit, WardenError>> {
	const timeoutMs = session.timeoutMs;
	if (plan.mode === "stable") {
		const stable = await waitStable(session, driver, plan.quietMs, timeoutMs);
		if (!stable.success) return stable;
		if (!stable.data.quiet) return fail(waitFailure(plan, "wait_not_stable", stable.data.waitedMs));
		return resultFactory.ok({ snapshot: stable.data.snapshot, waitedMs: stable.data.waitedMs });
	}
	const check =
		plan.mode === "visible"
			? visibleVerdict(plan.selector)
			: plan.mode === "text"
				? textVerdict(plan.text)
				: absentVerdict(plan.selector);
	const polled = await pollScreen<NodeEntry | null>(session, driver, timeoutMs, check);
	if (!polled.success) return polled;
	if (!polled.data.hit) return fail(waitFailure(plan, polled.data.reason, polled.data.waitedMs));
	const { value, snapshot, waitedMs } = polled.data;
	return resultFactory.ok({ ...(value ? { entry: value } : {}), snapshot, waitedMs });
}

/**
 * `wait`: poll every 100 ms for the first second, then every 250 ms (`stable` keeps 100 ms; deadline
 * `session.timeoutMs`) until the element is visible / gone, the text shows, or the screen holds still. The screen that
 * satisfied it is stored as the next generation, so the returned `@eN` can be used straight away. A miss fails with
 * `wait_target_absent` / `wait_target_hidden` / `wait_target_present` / `wait_text_absent` / `wait_not_stable`.
 */
export async function wait(session: OpSession, params: WaitParams): OpOutcome<WaitResult> {
	const plan = planOf(params);
	if (!plan.success) return plan;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const hit = await runWait(session, driver.data, plan.data);
	if (!hit.success) return hit;
	const { entry, snapshot, waitedMs } = hit.data;
	const { generation, refs } = storeSnapshot(session, snapshot);
	const ref = entry ? refs.byId.get(entry.element.id) : undefined;
	const line = entry ? renderEntryLine(entry, ref === undefined ? {} : { ref }) : undefined;
	const element: ElementJson | undefined = entry ? elementJson(entry, ref) : undefined;
	if (plan.data.mode === "visible" && entry) {
		await recordQuery(session, {
			action: "wait",
			selector: plan.data.selector,
			entry,
			snapshot,
			ref,
			args: { state: "visible", timeoutMs: session.timeoutMs },
		});
	}
	const text =
		line !== undefined
			? `waited ${waitedMs} ms: ${line}`
			: plan.data.mode === "stable"
				? `stable after ${waitedMs} ms`
				: `gone after ${waitedMs} ms`;
	return resultFactory.ok({
		generation,
		result: { matched: true, ...(ref !== undefined ? { ref } : {}), ...(element ? { element } : {}), waitedMs },
		text,
	});
}

type QueryRecord = {
	action: "wait" | "is" | "get";
	selector: ParsedSelector;
	entry: NodeEntry;
	snapshot: Snapshot;
	ref?: string | undefined;
	args: NonNullable<RecordStep["args"]>;
};

/**
 * Append a query that named an element to the session's recorder. The element and the snapshot it was found in go
 * along so the recording can build a durable selector chain; `stepsFromRecord` reads `args.state` / `args.timeoutMs`
 * (wait), `args.state` / `args.not` (is), `args.property` / `args.expected` (get).
 */
async function recordQuery(session: OpSession, query: QueryRecord): Promise<void> {
	if (!session.recorder) return;
	const { frame, tapPoint } = query.entry.element;
	const point = tapPoint ?? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	const target = recordTarget(
		{ kind: "selector", selector: query.selector },
		{
			kind: "selector",
			point,
			element: query.entry.element,
			snapshot: query.snapshot,
			...(query.ref !== undefined ? { ref: query.ref } : {}),
		}
	);
	const evidence = evidenceOf(target);
	await session.recorder.append(session.device.id, {
		action: query.action,
		target,
		args: query.args,
		...(evidence ? { evidence } : {}),
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

function parseQuerySelector(source: string, usage: string): Result<ParsedSelector, WardenError> {
	if (source.trim() === "") return fail(opError("usage", usage));
	const parsed = parseSelector(source);
	if (!parsed.success) return fail(opError("usage", `bad selector: ${parsed.error}`));
	return resultFactory.ok(parsed.data);
}

export type IsParams = { selector: string; state: IsState };

export type IsResult = {
	matched: boolean;
	state: IsState;
	element?: ElementJson;
	waitedMs: number;
	reason?: string;
};

/**
 * `is`: one look at the screen. `exit: 1` (and `matched: false`) when the element is not in that state, also when
 * nothing matches; only an engine failure fails.
 */
export async function is(session: OpSession, params: IsParams): OpOutcome<IsResult> {
	const { state } = params;
	const selector = parseQuerySelector(params.selector, `is needs a selector and a state: ${IS_STATES.join("|")}`);
	if (!selector.success) return selector;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const start = session.host.now();
	const taken = await driver.data.snapshot();
	if (!taken.success) return fail(driverError(taken.error));
	const entry = pickEntry(indexSnapshot(taken.data), selector.data);
	const matched = entry !== undefined && isState(entry, state);
	const reason = entry === undefined ? "target_absent" : matched ? undefined : `not_${state}`;
	if (entry) {
		await recordQuery(session, {
			action: "is",
			selector: selector.data,
			entry,
			snapshot: taken.data,
			args: { state, ...(matched ? {} : { not: true }) },
		});
	}
	return resultFactory.ok({
		result: {
			matched,
			state,
			...(entry ? { element: elementJson(entry, undefined) } : {}),
			waitedMs: Math.max(0, session.host.now() - start),
			...(reason !== undefined ? { reason } : {}),
		},
		text: matched ? "true" : "false",
		...(matched ? {} : { exit: 1 as const }),
	});
}

function frameText(entry: NodeEntry): string {
	const { x, y, width, height } = entry.element.frame;
	return `${x} ${y} ${width} ${height}`;
}

function propertyOf(entry: NodeEntry, prop: Exclude<GetProp, "count">): string | Rect {
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

export type GetParams = { selector: string; property: GetProp };

export type GetResult =
	| { matched: boolean; property: "count"; value: number; waitedMs: number }
	| {
			matched: true;
			property: Exclude<GetProp, "count">;
			value: string | Rect;
			element: ElementJson;
			waitedMs: number;
	  };

/**
 * `get`: one property of the element (`frame` is `x y w h` in the text). `count` is how many elements match (0 is
 * fine); the others need a match (`target_not_found`).
 */
export async function get(session: OpSession, params: GetParams): OpOutcome<GetResult> {
	const prop = params.property;
	const selector = parseQuerySelector(params.selector, `get needs a selector and a property: ${GET_PROPS.join("|")}`);
	if (!selector.success) return selector;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const start = session.host.now();
	const taken = await driver.data.snapshot();
	if (!taken.success) return fail(driverError(taken.error));
	const index = indexSnapshot(taken.data);
	const waitedMs = () => Math.max(0, session.host.now() - start);
	if (prop === "count") {
		const count = matchCount(index, selector.data);
		return resultFactory.ok({
			result: { matched: count > 0, property: "count", value: count, waitedMs: waitedMs() },
			text: String(count),
		});
	}
	const entry = pickEntry(index, selector.data);
	if (!entry) {
		return fail(
			opError("target_not_found", `${formatSelector(selector.data)} matched nothing`, {
				hint: "run `warden ui snapshot -i` to see what is on screen",
			})
		);
	}
	const value = propertyOf(entry, prop);
	if (typeof value === "string") {
		await recordQuery(session, {
			action: "get",
			selector: selector.data,
			entry,
			snapshot: taken.data,
			args: { property: prop, expected: value },
		});
	}
	return resultFactory.ok({
		result: {
			matched: true,
			property: prop,
			value,
			element: elementJson(entry, undefined),
			waitedMs: waitedMs(),
		},
		text: typeof value === "string" ? value : frameText(entry),
	});
}
