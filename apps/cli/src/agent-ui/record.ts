import type { Element, Point, Snapshot } from "@delacour/warden-e2e/driver/driver.types";

/** The target of a recorded action, as `warden ui` resolved it. */
export type RecordTarget = { ref?: string; selector?: string; point: Point };

/**
 * What a flow recording needs to turn a target into a durable selector chain: the element the action hit and the
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

/** One action a `warden ui` subcommand performed, handed to the active flow recording (WDN-E2E-A9). */
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
};

/** Where finished actions are appended while a recording is active. */
export type RecordSink = {
	append: (udid: string, step: RecordStep) => Promise<void>;
};

export const noRecordSink: RecordSink = { append: async () => undefined };
