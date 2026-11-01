import type { PerfReportJson } from "@delacour/warden-perf/shared/report";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import type { PerfEnv, PerfUiEnv } from "./env";
import type { StartOutcome, StopOutcome } from "./orchestrate";
import { perfPaths } from "./paths";
import type { PerfPlan } from "./plan";
import type { LaunchResult } from "./relaunch";
import { perfSessionStore } from "./session";
import type { PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

/** The `result` of `perf start --json`. */
export type StartResult = {
	sessionId: string;
	dir: string;
	app: string;
	maxDurationMs: number;
	capturers: Array<{ kind: string; state: string; out?: string }>;
	plan: PerfPlan;
	launch?: LaunchResult;
	leaseId?: string;
	next: string[];
};

/** The `result` of `perf stop --json`. */
export type StopResult = {
	sessionId: string;
	status: PerfSession["status"];
	stopReason: string | null;
	dir: string;
	reportPath?: string;
	report: PerfReportJson | null;
};

/** The `result` of `perf mark --json`. */
export type MarkResult = { sessionId: string; label: string; atMs: number };

/** PerfSessionOps: session ops. */
export class PerfSessionOps {
	/** The `result` of `perf start`: what armed, where the session lives and what to run next. */
	startResult(ctx: Pick<PerfEnv, "env">, out: StartOutcome, stopHint: string): StartResult {
		const { session, plan } = out;
		return {
			sessionId: session.id,
			dir: perfPaths.sessionDir(ctx, session.id),
			app: session.app?.id ?? plan.app,
			maxDurationMs: session.maxDurationMs,
			capturers: session.capturers.map((c) => ({
				kind: c.kind,
				state: c.state,
				...(c.out === undefined ? {} : { out: c.out }),
			})),
			plan,
			...(out.launch === undefined ? {} : { launch: out.launch }),
			...(out.leaseId === undefined ? {} : { leaseId: out.leaseId }),
			next: ['warden perf mark "<what you are about to do>"', stopHint],
		};
	}

	/** The `result` of `perf stop`: the stopped session and its merged report. */
	stopResult(ctx: Pick<PerfEnv, "env">, out: StopOutcome): StopResult {
		const { session, report } = out;
		return {
			sessionId: session.id,
			status: session.status,
			stopReason: session.stopReason ?? null,
			dir: perfPaths.sessionDir(ctx, session.id),
			...(out.reportPath === undefined ? {} : { reportPath: out.reportPath }),
			report: report ?? null,
		};
	}

	/** `+3.2s` */
	private readonly offset = (ms: number): string => `+${(ms / 1000).toFixed(1)}s`;

	/** Annotate the device's active session: hangs and jank are tagged with the last mark before them. */
	async markWork(ctx: PerfUiEnv, deps: PerfEngineDeps, target: PerfTarget, rawLabel: string): PerfOutcome<MarkResult> {
		const label = rawLabel.trim();
		if (label === "") return { success: false, error: opErrors.opError("usage", "a mark needs a label") };
		const session = perfSessionStore.activeSessionFor(ctx, deps.session, target.udid);
		if (session === undefined) {
			return {
				success: false,
				error: opErrors.opError("session_not_found", `no active perf session on ${target.udid}`, {
					hint: "warden perf start (marks only land in a running session)",
				}),
			};
		}
		const wallMs = ctx.now();
		const atMs = wallMs - session.startedAt.wallMs;
		perfSessionStore.updateSession(ctx, session.id, (s) => ({ ...s, marks: [...s.marks, { label, wallMs, atMs }] }));
		return resultFactory.ok({
			device: { udid: target.udid, platform: target.platform, name: target.name },
			result: { sessionId: session.id, label, atMs },
			text: `${ctx.ui.color.green("marked")} "${label}" at ${this.offset(atMs)} ${ctx.ui.color.dim(session.id)}`,
		});
	}
}

export const perfSessionOps = new PerfSessionOps();
