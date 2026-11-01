import type { Driver } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { formatSelector } from "@delacour/warden-screen/selector";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { SnapshotDiff } from "./diff";
import { fail, opError } from "./errors";
import { attachEvidence, evidenceOf, type RecordSink, type RecordStep, type RecordTarget } from "./record";
import type { OpOutcome, OpSession } from "./session";
import { settleLines, type TakenSnapshot, takeSnapshot } from "./snapshot";
import { parseTarget, type ResolvedTarget, resolveTarget, type Target } from "./target";

/** What `--settle` reports once the screen was waited on: the verdict and the diff against the previous snapshot. */
export type SettledResult = { quiet: boolean; waitedMs: number; diff: (SnapshotDiff & { against: number }) | null };

/** The `--json` result every action shares; ops add their own fields to it. */
export type ActionResult = {
	action: string;
	target?: RecordTarget;
	settled?: SettledResult;
	verified?: boolean | "unconfirmed";
};

/** What one action reports before it is wrapped up by {@link finishAction}. */
export type ActionDone<Extra extends object = Record<never, never>> = {
	action: string;
	/** one line for humans */
	text: string;
	target?: RecordTarget;
	verified?: boolean | "unconfirmed";
	/** the action's own arguments: appended to the recording (never put a secret here) */
	args?: RecordStep["args"];
	/** text typed into a secure field: the recording only names it (`WARDEN_UI_SECRET_*`), never stores it */
	secret?: string;
	/** more result fields (`direction`, `swipes`, `path`, …) */
	extra?: Extra;
};

function settledResult(taken: TakenSnapshot): SettledResult {
	return {
		quiet: taken.settle?.quiet ?? true,
		waitedMs: taken.settle?.waitedMs ?? 0,
		diff: taken.diff ?? null,
	};
}

/** `--settle`: wait for a quiet screen and take the diffed snapshot, or nothing when no budget was asked for. */
async function settleAfter(
	session: OpSession,
	driver: Driver,
	settleMs: number | undefined
): Promise<Result<TakenSnapshot | undefined, WardenError>> {
	if (settleMs === undefined) return resultFactory.ok(undefined);
	const snap = await takeSnapshot(session, driver, {
		interactiveOnly: true,
		all: false,
		settle: { budgetMs: settleMs },
	});
	return snap.success ? resultFactory.ok(snap.data) : snap;
}

/** Append the finished action to the session's recorder (with the route it navigated to, when the session reads one). */
async function recordAction(
	session: OpSession,
	recorder: RecordSink,
	settleMs: number | undefined,
	done: ActionDone
): Promise<void> {
	const evidence = done.target ? evidenceOf(done.target) : undefined;
	const route = await session.routeAfter?.(done.action);
	await recorder.append(session.device.id, {
		action: done.action,
		...(done.target ? { target: done.target } : {}),
		...(done.args ? { args: done.args } : {}),
		...(evidence ? { evidence } : {}),
		...(settleMs !== undefined ? { settle: { timeoutMs: settleMs } } : {}),
		...(done.secret !== undefined ? { secret: done.secret } : {}),
		...(route !== undefined ? { route } : {}),
	});
}

/**
 * Wrap up an action: `settleMs` waits for a quiet screen and diffs it against the stored snapshot (a new
 * generation, so `@eN` refs from before are replaced), the step is appended to the session's recorder (if it has
 * one), and the result is shaped for text and JSON.
 */
export async function finishAction<Extra extends object = Record<never, never>>(
	session: OpSession,
	driver: Driver,
	settleMs: number | undefined,
	done: ActionDone<Extra>
): OpOutcome<ActionResult & Extra> {
	const settled = await settleAfter(session, driver, settleMs);
	if (!settled.success) return settled;
	const taken = settled.data;
	if (session.recorder) await recordAction(session, session.recorder, settleMs, done);
	const result: ActionResult = {
		action: done.action,
		...(done.target ? { target: done.target } : {}),
		...(taken ? { settled: settledResult(taken) } : {}),
		...(done.verified !== undefined ? { verified: done.verified } : {}),
	};
	const warnings = taken?.settle && !taken.settle.quiet ? ["screen did not settle within the budget"] : [];
	return resultFactory.ok({
		...(taken ? { generation: taken.generation } : {}),
		result: { ...result, ...done.extra } as ActionResult & Extra,
		text: [done.text, ...(taken ? settleLines(taken) : [])].join("\n"),
		warnings,
	});
}

/** The words of a target as one target: `@e3`, `id=email`, or `x y`. An empty string is a usage error. */
export function targetOf(text: string): Result<Target, WardenError> {
	if (text.trim() === "") {
		return fail(opError("usage", "missing target", { hint: "use @eN, a selector or `x y`" }));
	}
	return parseTarget(text);
}

/** The target an action points at: parsed, resolved against the stored (or a fresh) snapshot. */
export async function pointAt(
	session: OpSession,
	driver: Driver,
	target: Target,
	verify: boolean
): Promise<Result<ResolvedTarget, WardenError>> {
	return resolveTarget(target, { lastSnapshot: session.refs.last(), now: session.host.now(), verify, driver });
}

/** How a resolved target is reported: `ref`, the selector text, the screen point. */
export function recordTarget(target: Target, resolved: ResolvedTarget): RecordTarget {
	const where: RecordTarget = {
		...(resolved.ref !== undefined ? { ref: resolved.ref } : {}),
		...(target.kind === "selector" ? { selector: formatSelector(target.selector) } : {}),
		point: resolved.point,
	};
	return resolved.element && resolved.snapshot
		? attachEvidence(where, { element: resolved.element, snapshot: resolved.snapshot })
		: where;
}

/** `@e3`, `id=email` or `(120,340)`: a target in one line of text. */
export function targetLabel(target: RecordTarget): string {
	return target.ref ?? target.selector ?? `(${Math.round(target.point.x)},${Math.round(target.point.y)})`;
}

/** A thrown `E2eError` (from `createDevice`) as an op error. */
export function fromE2eError(error: unknown): WardenError | undefined {
	if (!(error instanceof E2eError)) return undefined;
	if (error.code === "DRIVER") return opError("engine_unavailable", error.message);
	return opError("failed", error.message);
}
