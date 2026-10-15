import type { Result } from "@delacour/warden-types/result";
import type { Driver, Element, Point, Rect, Snapshot } from "../driver/driver.types";
import { snapshotHash } from "../driver/settle";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "../screen/nodes";
import { renderSnapshot } from "../screen/render";
import { matchesSelector, parseSelector } from "../screen/selector";
import type { ChainEntry, Flow, SelectorTarget, Step, StepKind, StepOf, Target, Text } from "./flow.schema";
import { type Env, resolveText } from "./record";

/**
 * Replay: re-run a recorded flow against a live screen. Per step the target chain is resolved against a fresh
 * snapshot (first entry that matches exactly one element wins), checked against the recorded landmark, and only then
 * handed to the injected executor for that step kind. Pure: every side effect (driver, actions, clock, log) comes in
 * through `ReplayDeps`, and the file is never touched; `updateSnapshots` hands back a refreshed `Flow` for the caller.
 */

/** Maximum distance (points) between the recorded landmark centre and the element the chain found. */
export const LANDMARK_TOLERANCE = 40;

const EXCERPT_LINES = 40;

export type ActError = { code: string; message: string };

export type ResolvedTarget = {
	point: Point;
	/** how it was found: the chain entry that matched, or the recorded coordinates */
	via: "id" | "role-label" | "role-text" | "path" | "coords";
	element?: Element;
	entry?: NodeEntry;
};

export type StepTargets = { target?: ResolvedTarget; until?: ResolvedTarget };

/** A recorded target looked up on the current screen: where it is, or why it is not there. */
export type Located = { resolved: ResolvedTarget } | { missing: string };

export type ActContext = {
	driver: Driver;
	/** the snapshot the targets were resolved in; undefined for steps that did not need one */
	snapshot: Snapshot | undefined;
	/**
	 * Targets resolved before the action. `wait`, `is`, `get` and `scroll` (with `until`) are not: their target may
	 * only appear (or vanish) during the step, so those executors look it up themselves with `find`.
	 */
	targets: StepTargets;
	/** resolve a recorded target against a fresh snapshot (chain + landmark); never throws */
	find(target: Target): Promise<Result<Located, ActError>>;
	/** plain text for a stored `Text` (secrets already looked up; checked before the step runs) */
	text(value: Text): string;
};

export type StepActor<K extends StepKind> = (step: StepOf<K>, ctx: ActContext) => Promise<Result<void, ActError>>;

/** One executor per step kind; the CLI binds real driver actions, tests bind recorders. */
export type ActMap = { [K in StepKind]: StepActor<K> };

/** Reported after every step that ran: what it was, how long it took, and whether the screen had drifted. */
export type StepEvent = { step: number; kind: StepKind; label: string; ms: number; drift?: ReplayDrift };

export type ReplayDeps = {
	driver: Driver;
	/** a fresh snapshot; called once per step that has a target */
	snapshot: () => Promise<Result<Snapshot, ActError>>;
	act: ActMap;
	/** the recorded `--settle`, run after the action */
	settle: (options: { quietMs?: number; timeoutMs?: number }) => Promise<Result<unknown, ActError>>;
	now: () => number;
	log: (line: string) => void;
	/** env that holds `WARDEN_UI_SECRET_*` */
	env?: Env;
	/** skip steps before this index */
	from?: number;
	/** refresh landmarks and snapshot hashes from this run and return the new flow in `updated` */
	updateSnapshots?: boolean;
	onStep?: (event: StepEvent) => void;
};

export type ReplayDrift = { step: number; expected: string; actual: string };

export type ReplayOutcome =
	| { status: "passed"; steps: number; warnings: ReplayDrift[]; updated?: Flow }
	| {
			status: "diverged";
			code: "replay_divergence";
			step: number;
			kind: StepKind;
			reason: string;
			/** interactive tree of the screen the step could not be placed in */
			snapshot: string;
			warnings: ReplayDrift[];
	  }
	| {
			status: "failed";
			step: number;
			kind: StepKind;
			error: ActError;
			snapshot?: string;
			warnings: ReplayDrift[];
	  };

// ---- targets and texts of a step --------------------------------------------------------------------------------

type StepSlots = { target?: Target; until?: Target };

/** The targets a step points at. `swipe` hides its target inside the gesture, `scroll` calls it `until`. */
export function targetsOf(step: Step): StepSlots {
	switch (step.kind) {
		case "press":
		case "longpress":
		case "fill":
		case "wait":
		case "is":
		case "get":
			return { target: step.target };
		case "type":
		case "key":
			return step.target ? { target: step.target } : {};
		case "swipe":
			return step.gesture.by === "direction" && step.gesture.target ? { target: step.gesture.target } : {};
		case "scroll":
			return step.until ? { until: step.until } : {};
		default:
			return {};
	}
}

/** One line for a step: its target (selector or point), else the thing it opens, presses or sets. */
export function describeStep(step: Step): string {
	const { target, until } = targetsOf(step);
	const where = target ?? until;
	if (where) return where.kind === "selector" ? where.selector : `(${Math.round(where.x)},${Math.round(where.y)})`;
	switch (step.kind) {
		case "open":
			return step.app ?? step.url ?? "";
		case "key":
			return step.key;
		case "alert":
			return typeof step.action === "string" ? step.action : step.action.button;
		case "rotate":
			return step.orientation;
		case "appearance":
			return step.mode;
		case "scroll":
			return step.direction ?? "down";
		case "swipe":
			return step.gesture.by === "direction" ? step.gesture.direction : "path";
		default:
			return "";
	}
}

/** Steps whose target may only appear (or vanish) while they run; their executors resolve it themselves. */
const LAZY_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(["wait", "is", "get", "scroll"]);

function eagerSlots(step: Step, slots: StepSlots): StepSlots {
	return LAZY_KINDS.has(step.kind) ? {} : slots;
}

function withTargets(step: Step, slots: StepSlots): Step {
	switch (step.kind) {
		case "press":
		case "longpress":
		case "fill":
		case "wait":
		case "is":
		case "get":
		case "type":
		case "key":
			return slots.target ? { ...step, target: slots.target } : step;
		case "swipe":
			return step.gesture.by === "direction" && slots.target
				? { ...step, gesture: { ...step.gesture, target: slots.target } }
				: step;
		case "scroll":
			return slots.until ? { ...step, until: slots.until } : step;
		default:
			return step;
	}
}

function textsOf(step: Step): Text[] {
	switch (step.kind) {
		case "fill":
		case "type":
			return [step.text];
		case "get":
			return [step.expected];
		default:
			return [];
	}
}

// ---- resolving a target -----------------------------------------------------------------------------------------

function centreOf(rect: Rect): Point {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function pointOf(element: Element): Point {
	return element.tapPoint ?? centreOf(element.frame);
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

type Found = { entry: NodeEntry; by: "id" | "role-label" | "role-text" | "path" };

/** One chain entry against the screen: the element it names, or why it names none. */
function tryLink(link: ChainEntry, index: NodeIndex): { found: Found } | { note: string } {
	if (link.by === "path") {
		const entry = index.byId.get(link.path);
		return entry && entry.role === link.role ? { found: { entry, by: "path" } } : { note: `path ${link.path}` };
	}
	const parsed = parseSelector(link.selector);
	if (!parsed.success) return { note: `${link.selector} (unparseable)` };
	const { nth, ...rest } = parsed.data;
	const matches = index.entries.filter((entry) => matchesSelector(entry, rest));
	const picked = nth === undefined ? (matches.length === 1 ? matches[0] : undefined) : matches[nth];
	if (picked) return { found: { entry: picked, by: link.by } };
	return { note: `${link.selector} (${matches.length === 0 ? "no match" : `${matches.length} matches`})` };
}

/** The first chain entry that names exactly one element (an `nth=` entry names the one it counts to). */
function walkChain(target: SelectorTarget, index: NodeIndex): { found: Found } | { tried: string } {
	const notes: string[] = [];
	for (const link of target.chain) {
		const outcome = tryLink(link, index);
		if ("found" in outcome) return outcome;
		notes.push(outcome.note);
	}
	return { tried: notes.join(", ") };
}

type Resolution = { resolved: ResolvedTarget } | { divergence: string };

function resolveTarget(target: SelectorTarget, index: NodeIndex): Resolution {
	const walked = walkChain(target, index);
	if ("tried" in walked) return { divergence: `${target.selector} is gone; tried ${walked.tried}` };
	const { entry, by } = walked.found;
	const { landmark } = target;
	if (entry.role !== landmark.role) {
		return { divergence: `${target.selector} now resolves to a ${entry.role}, recorded as a ${landmark.role}` };
	}
	const moved = distance(centreOf(landmark.frame), centreOf(entry.element.frame));
	if (moved > LANDMARK_TOLERANCE) {
		return {
			divergence: `${target.selector} moved ${Math.round(moved)} pt from where it was recorded (limit ${LANDMARK_TOLERANCE})`,
		};
	}
	return { resolved: { point: pointOf(entry.element), via: by, element: entry.element, entry } };
}

function refreshed(target: Target, resolved: ResolvedTarget): Target {
	if (target.kind !== "selector" || !resolved.entry) return target;
	const { entry } = resolved;
	return {
		...target,
		landmark: {
			role: entry.role,
			frame: { ...entry.element.frame },
			...(entry.name !== undefined && { label: entry.name }),
		},
	};
}

function toLocated(target: SelectorTarget, index: NodeIndex): Located {
	const outcome = resolveTarget(target, index);
	return "divergence" in outcome ? { missing: outcome.divergence } : outcome;
}

function excerpt(snapshot: Snapshot): string {
	return renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map(), maxLines: EXCERPT_LINES }).lines.join("\n");
}

function dispatch(act: ActMap, step: Step, ctx: ActContext): Promise<Result<void, ActError>> {
	// one cast: `act[step.kind]` takes exactly the step kind it is keyed by, which the type system cannot correlate here
	const actor = act[step.kind] as (step: Step, ctx: ActContext) => Promise<Result<void, ActError>>;
	return actor(step, ctx);
}

// ---- the replay loop --------------------------------------------------------------------------------------------

type Stop = Exclude<ReplayOutcome, { status: "passed" }>;

function failedStep(step: Step, error: ActError, warnings: ReplayDrift[], snapshot?: Snapshot): Stop {
	return {
		status: "failed",
		step: step.i,
		kind: step.kind,
		error,
		...(snapshot && { snapshot: excerpt(snapshot) }),
		warnings,
	};
}

function divergedStep(step: Step, reason: string, snapshot: Snapshot | undefined, warnings: ReplayDrift[]): Stop {
	return {
		status: "diverged",
		code: "replay_divergence",
		step: step.i,
		kind: step.kind,
		reason,
		snapshot: snapshot ? excerpt(snapshot) : "",
		warnings,
	};
}

/** The first secret a step needs that `env` does not provide. */
function missingSecret(step: Step, env: Env): ActError | undefined {
	for (const value of textsOf(step)) {
		const plain = resolveText(value, env);
		if (!plain.success) return { code: "missing_secret", message: plain.error };
	}
	return undefined;
}

/** Targets resolved for one step, plus the same targets with landmarks as seen now (for `updateSnapshots`). */
type Placed = { targets: StepTargets; refreshed: StepSlots } | { divergence: string };

function place(slots: StepSlots, snapshot: Snapshot | undefined, step: Step, log: (line: string) => void): Placed {
	const targets: StepTargets = {};
	const refreshedSlots: StepSlots = {};
	const index = snapshot ? indexSnapshot(snapshot) : undefined;
	for (const slot of ["target", "until"] as const) {
		const want = slots[slot];
		if (!want) continue;
		if (want.kind === "coords") {
			targets[slot] = { point: { x: want.x, y: want.y }, via: "coords" };
			log(`step ${step.i} ${step.kind}: ${want.warning}`);
		} else if (index) {
			const outcome = resolveTarget(want, index);
			if ("divergence" in outcome) return outcome;
			targets[slot] = outcome.resolved;
			refreshedSlots[slot] = refreshed(want, outcome.resolved);
		}
	}
	return { targets, refreshed: refreshedSlots };
}

const wantsScreen = (step: Step, slots: StepSlots): boolean =>
	step.kind === "snapshot" || needsTarget(slots) || (step.snapshotHash !== undefined && step.kind !== "open");

function needsTarget(slots: StepSlots): boolean {
	return slots.target?.kind === "selector" || slots.until?.kind === "selector";
}

function noteDrift(step: Step, hash: string | undefined, log: (line: string) => void, warnings: ReplayDrift[]): void {
	if (hash === undefined || step.snapshotHash === undefined || step.snapshotHash === hash) return;
	warnings.push({ step: step.i, expected: step.snapshotHash, actual: hash });
	log(`drift step ${step.i} ${step.kind}: screen differs from the recording (${step.snapshotHash} → ${hash})`);
}

type StepDone = { hash: string | undefined; refreshed: StepSlots };

/** One step: secrets, fresh screen, drift, place the targets, act, settle. Either a stop or what `updateSnapshots` needs. */
async function runStep(
	step: Step,
	deps: ReplayDeps,
	warnings: ReplayDrift[]
): Promise<{ stop: Stop } | { done: StepDone }> {
	const env = deps.env ?? {};
	const slots = eagerSlots(step, targetsOf(step));
	const secret = missingSecret(step, env);
	if (secret) return { stop: failedStep(step, secret, warnings) };

	let snapshot: Snapshot | undefined;
	if (wantsScreen(step, slots)) {
		const taken = await deps.snapshot();
		if (taken.success) snapshot = taken.data;
		else if (needsTarget(slots)) return { stop: failedStep(step, taken.error, warnings) };
	}

	const hash = snapshot ? snapshotHash(snapshot) : undefined;
	noteDrift(step, hash, deps.log, warnings);

	const placed = place(slots, snapshot, step, deps.log);
	if ("divergence" in placed) {
		deps.log(`replay_divergence step ${step.i} ${step.kind}: ${placed.divergence}`);
		return { stop: divergedStep(step, placed.divergence, snapshot, warnings) };
	}

	const text = (value: Text): string => {
		const plain = resolveText(value, env);
		return plain.success ? plain.data : "";
	};
	const find = async (target: Target): Promise<Result<Located, ActError>> => {
		if (target.kind === "coords") {
			return { success: true, data: { resolved: { point: { x: target.x, y: target.y }, via: "coords" } } };
		}
		const taken = await deps.snapshot();
		if (!taken.success) return taken;
		return { success: true, data: toLocated(target, indexSnapshot(taken.data)) };
	};
	const context: ActContext = { driver: deps.driver, snapshot, targets: placed.targets, find, text };
	const acted = await dispatch(deps.act, step, context);
	if (!acted.success) {
		deps.log(`step ${step.i} ${step.kind} failed: ${acted.error.code}: ${acted.error.message}`);
		if (acted.error.code === "replay_divergence") {
			const screen = snapshot ?? (await deps.snapshot().then((taken) => (taken.success ? taken.data : undefined)));
			return { stop: divergedStep(step, acted.error.message, screen, warnings) };
		}
		return { stop: failedStep(step, acted.error, warnings, snapshot) };
	}
	if (step.settle) {
		const settled = await deps.settle(step.settle);
		if (!settled.success) deps.log(`step ${step.i} ${step.kind}: settle failed: ${settled.error.message}`);
	}
	return { done: { hash, refreshed: placed.refreshed } };
}

export async function replayFlow(flow: Flow, deps: ReplayDeps): Promise<ReplayOutcome> {
	const warnings: ReplayDrift[] = [];
	const updatedSteps: Step[] = [...flow.steps];
	const from = deps.from ?? 0;
	let executed = 0;

	for (const step of flow.steps) {
		if (step.i < from) continue;
		const started = deps.now();
		const outcome = await runStep(step, deps, warnings);
		if ("stop" in outcome) return outcome.stop;
		if (deps.updateSnapshots) {
			const next = withTargets(step, outcome.done.refreshed);
			updatedSteps[step.i] = outcome.done.hash === undefined ? next : { ...next, snapshotHash: outcome.done.hash };
		}
		executed += 1;
		const ms = Math.round(deps.now() - started);
		deps.log(`step ${step.i} ${step.kind} ok (${ms} ms)`);
		const drift = warnings.find((warning) => warning.step === step.i);
		deps.onStep?.({ step: step.i, kind: step.kind, label: describeStep(step), ms, ...(drift && { drift }) });
	}

	return {
		status: "passed",
		steps: executed,
		warnings,
		...(deps.updateSnapshots && { updated: { ...flow, steps: updatedSteps } }),
	};
}
