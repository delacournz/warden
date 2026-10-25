import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-e2e/driver/settle";
import { E2eError } from "@delacour/warden-e2e/errors";
import { formatSelector } from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { appendRecorded, attachEvidence, evidenceOf, type RecordStep, type RecordTarget, routeAfter } from "./record";
import type { UiOptionValues, UiRunEnv } from "./run";
import { settleLines, type TakenSnapshot, takeSnapshot } from "./snapshot";
import { positiveInt } from "./snapshot-command";
import { readLastSnapshot } from "./state";
import { parseTarget, type ResolvedTarget, resolveTarget, type Target } from "./target";

/** Options of every action that can wait for the screen to settle afterwards. */
export type ActionOptionValues = UiOptionValues & {
	/** `--settle` alone = true, `--settle 5000` = "5000" */
	settle?: true | string;
};

/** `--settle [ms]` → the budget, or undefined when not asked for. */
export function parseSettle(raw: true | string | undefined): Result<number | undefined, UiError> {
	if (raw === undefined) return ok(undefined);
	if (raw === true) return ok(DEFAULT_SETTLE_TIMEOUT_MS);
	return positiveInt("--settle", raw);
}

/** What one action reports: the `--json` result is this, plus the settle verdict. */
export type ActionDone = {
	action: string;
	/** one line for humans */
	text: string;
	target?: RecordTarget;
	verified?: boolean | "unconfirmed";
	/** the action's own arguments: appended to the recording (never put a secret here) */
	args?: RecordStep["args"];
	/** text typed into a secure field: the recording only names it (`WARDEN_UI_SECRET_*`), never stores it */
	secret?: string;
	/** more `--json` fields (`direction`, `swipes`, `path`, …) */
	extra?: Record<string, unknown>;
};

function settledJson(taken: TakenSnapshot): Record<string, unknown> {
	return {
		quiet: taken.settle?.quiet ?? true,
		waitedMs: taken.settle?.waitedMs ?? 0,
		diff: taken.diff ?? null,
	};
}

/**
 * Wrap up an action: `--settle` waits for a quiet screen and diffs it against the stored snapshot (a new
 * generation, so `@eN` refs from before are replaced), the step is appended to the active recording
 * (unless `--no-record`), and the result is shaped for text and `--json`.
 */
export async function finishAction(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice,
	driver: Driver,
	settleBudget: number | undefined,
	done: ActionDone
): Promise<Result<UiSuccess, UiError>> {
	let taken: TakenSnapshot | undefined;
	if (settleBudget !== undefined) {
		const snap = await takeSnapshot(ctx, deps, driver, device.udid, {
			interactiveOnly: true,
			all: false,
			settle: { budgetMs: settleBudget },
		});
		if (!snap.success) return snap;
		taken = snap.data;
	}
	if (env.record) {
		const evidence = done.target ? evidenceOf(done.target) : undefined;
		const route = await routeAfter(ctx, deps, env, device, done.action);
		await appendRecorded(ctx, deps, device.udid, {
			action: done.action,
			...(done.target ? { target: done.target } : {}),
			...(done.args ? { args: done.args } : {}),
			...(evidence ? { evidence } : {}),
			...(settleBudget !== undefined ? { settle: { timeoutMs: settleBudget } } : {}),
			...(done.secret !== undefined ? { secret: done.secret } : {}),
			...(route !== undefined ? { route } : {}),
		});
	}
	const result: Record<string, unknown> = {
		action: done.action,
		...(done.target ? { target: done.target } : {}),
		...(taken ? { settled: settledJson(taken) } : {}),
		...(done.verified !== undefined ? { verified: done.verified } : {}),
		...done.extra,
	};
	const warnings = taken?.settle && !taken.settle.quiet ? ["screen did not settle within the budget"] : [];
	return ok({
		device: { udid: device.udid, platform: device.platform, name: device.name },
		...(taken ? { generation: taken.generation } : {}),
		result,
		text: [done.text, ...(taken ? settleLines(taken) : [])].join("\n"),
		warnings,
	});
}

/** The words after a subcommand as one target. */
export function targetOf(words: readonly string[]): Result<Target, UiError> {
	if (words.length === 0) {
		return { success: false, error: uiError("usage", "missing target", { hint: "use @eN, a selector or `x y`" }) };
	}
	return parseTarget(words.join(" "));
}

/** The target an action points at: parsed, resolved against the stored (or a fresh) snapshot. */
export async function pointAt(
	ctx: CommandContext,
	driver: Driver,
	udid: string,
	target: Target,
	verify: boolean
): Promise<Result<ResolvedTarget, UiError>> {
	return resolveTarget(target, { lastSnapshot: readLastSnapshot(ctx, udid), now: ctx.now(), verify, driver });
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

/** A thrown `E2eError` (from `createDevice`) as a `warden ui` error. */
export function fromE2eError(error: unknown): UiError | undefined {
	if (!(error instanceof E2eError)) return undefined;
	if (error.code === "DRIVER") return uiError("engine_unavailable", error.message);
	return uiError("failed", error.message);
}
