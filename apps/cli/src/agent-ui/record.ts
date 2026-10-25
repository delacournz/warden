import type { Element, Point, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import type { UiRunEnv } from "./run";
import { readState } from "./state";

/** The target of a recorded action, as `warden ui` resolved it. */
export type RecordTarget = { ref?: string; selector?: string; point: Point };

/**
 * What a recording needs to turn a target into a durable selector chain: the element the action hit and the
 * snapshot it was resolved in. Kept off `RecordTarget` itself so it never reaches `--json` output.
 */
export type RecordEvidence = { element: Element; snapshot: Snapshot };

const evidenceByTarget = new WeakMap<RecordTarget, RecordEvidence>();

/** Remember the element + snapshot behind a `RecordTarget` (see `act.ts` `recordTarget`). */
export function attachEvidence(target: RecordTarget, evidence: RecordEvidence): RecordTarget {
	evidenceByTarget.set(target, evidence);
	return target;
}

export function evidenceOf(target: RecordTarget): RecordEvidence | undefined {
	return evidenceByTarget.get(target);
}

/** One action a `warden ui` subcommand performed, handed to the active recording. */
export type RecordStep = {
	/** subcommand name: `press`, `fill`, `swipe`, `open`, … */
	action: string;
	target?: RecordTarget;
	/** the action's own arguments (`text`, `direction`, `bundleId`, …); secrets are left out, `secure: true` instead */
	args?: Record<string, string | number | boolean>;
	/** element + snapshot the target was resolved in */
	evidence?: RecordEvidence;
	/** the action ran with `--settle` and this budget */
	settle?: { timeoutMs: number };
	/**
	 * Text typed into a secure field. Only ever compared with `WARDEN_UI_SECRET_*` values to name the secret;
	 * the sink must never write it down.
	 */
	secret?: string;
	/** the route the app is on after the action, when it changed (see `route-capture.ts`) */
	route?: string;
};

/** Where finished actions are appended while a recording is active. */
export type RecordSink = {
	append: (udid: string, step: RecordStep) => Promise<void>;
};

/** Actions that can change the screen the app shows; only these are worth a route read. */
const NAVIGATING: ReadonlySet<string> = new Set(["press", "tap", "open", "back", "key", "alert", "use"]);

/**
 * The route the app moved to after `action`, when a recording is active and the action can navigate. Best effort: any
 * failure (release build, no Metro, slow app) is no route, never an error. Nothing is loaded for other actions.
 */
export async function routeAfter(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice,
	action: string
): Promise<string | undefined> {
	if (!NAVIGATING.has(action) || !readState(ctx, device.udid).recording) return undefined;
	const { captureRoute } = await import("./route-capture");
	return captureRoute(ctx, deps, env, device);
}

/**
 * Hand a finished action to the recording: the test sink when `deps.record` is set, else the active recording's journal.
 * Nothing is loaded or written when no recording is active, so an ordinary action never imports the journal code.
 */
export async function appendRecorded(ctx: CommandContext, deps: UiDeps, udid: string, step: RecordStep): Promise<void> {
	if (deps.record) return deps.record.append(udid, step);
	if (!readState(ctx, udid).recording) return;
	const { journalSink } = await import("./record-sink");
	await journalSink(ctx).append(udid, step);
}
