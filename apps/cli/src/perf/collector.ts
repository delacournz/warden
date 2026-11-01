import { join } from "node:path";
import type { Capturer } from "@delacour/warden-perf/shared/session.schema";
import { autoStop } from "@delacour/warden-sdk/ops/perf/auto-stop";
import { COLLECT_METRICS_INTERVAL_MS, metricsTickers } from "@delacour/warden-sdk/ops/perf/collect-metrics";
import { perfFramesOps } from "@delacour/warden-sdk/ops/perf/frames";
import { defaultJsDeps, JS_DIR, type JsDeps, jsCaptureService } from "@delacour/warden-sdk/ops/perf/js-capture";
import { defaultLogDeps, type LogDeps, perfLogsOps } from "@delacour/warden-sdk/ops/perf/logs";
import { SAMPLES_FILE } from "@delacour/warden-sdk/ops/perf/metrics-out";
import { perfPaths } from "@delacour/warden-sdk/ops/perf/paths";
import { type PerfPlan, perfPlans } from "@delacour/warden-sdk/ops/perf/plan";
import { reactCapture } from "@delacour/warden-sdk/ops/perf/react-capture";
import { perfSessionStore } from "@delacour/warden-sdk/ops/perf/session";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { hookJson } from "../hooks/json";
import { perfBrokerResumeCli } from "./broker-resume";
import type { PerfTarget } from "./device";
import { perfJsCli } from "./js";
import type { PerfDeps } from "./run";

/** How long JS / React wait for the app's Metro target: a relaunched app needs time to boot and register. */
const RELAUNCH_TARGET_WAIT_MS = 60_000;
const ATTACHED_TARGET_WAIT_MS = 8_000;
const TARGET_POLL_MS = 1_000;
const CONNECT_TIMEOUT_MS = 5_000;

/** What the collector reaches the outside world through; tests inject fakes. */
export type CollectorDeps = {
	js: JsDeps;
	logs: LogDeps;
	/** abort-aware sleep */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** run the stop path after the session hit its cap (`perf stop`'s own, minus waiting for a collector) */
	finalize?: (id: string) => Promise<unknown>;
	log: (line: string) => void;
};

export type CaptureKind = Capturer["kind"];

type Sink = (kind: CaptureKind, patch: Partial<Omit<Capturer, "kind">>) => void;

export type CaptureEnv = {
	ctx: CommandContext;
	perfDeps: PerfDeps;
	deps: CollectorDeps;
	id: string;
	plan: PerfPlan;
	target: PerfTarget;
	startMs: number;
	maxDurationMs: number;
	signal: AbortSignal;
	set: Sink;
	dir: string;
};

type Cdp = Parameters<typeof reactCapture.startReactCapture>[0];
type ReactOwner = Awaited<ReturnType<typeof reactCapture.reactOwner>>;

/** One long-lived capture the detached collector hosts: gated by the plan, failure-contained, marked failed on a throw. */
export abstract class CaptureTask {
	abstract readonly name: string;
	abstract enabled(plan: PerfPlan): boolean;
	/** the capturers to mark `failed` when `run` throws */
	protected abstract failedKinds(plan: PerfPlan): readonly CaptureKind[];
	protected abstract run(e: CaptureEnv): Promise<void>;

	async guarded(e: CaptureEnv): Promise<void> {
		try {
			await this.run(e);
		} catch (error) {
			e.deps.log(`${this.name}: ${hookJson.errorMessage(error)}`);
			for (const kind of this.failedKinds(e.plan)) e.set(kind, { state: "failed" });
		}
	}
}

class MetricsTask extends CaptureTask {
	readonly name = "metrics";
	enabled(plan: PerfPlan): boolean {
		return plan.metrics;
	}
	protected failedKinds(): readonly CaptureKind[] {
		return ["metrics"];
	}
	protected async run(e: CaptureEnv): Promise<void> {
		const { ctx, plan, target } = e;
		const fps =
			target.platform === "android"
				? async () => (await perfFramesOps.androidFrameRate(ctx, target.udid, plan.app))?.fps
				: undefined;
		const ticker = await metricsTickers.createMetricsTicker(ctx, {
			target: { udid: target.udid, platform: target.platform, app: plan.app },
			sessionDir: e.dir,
			startMs: e.startMs,
			...(fps === undefined ? {} : { fps }),
		});
		if (!ticker.success) {
			e.deps.log(`metrics: ${ticker.error.message}`);
			e.set("metrics", { state: "failed" });
			return;
		}
		e.set("metrics", { state: "running", out: join(e.dir, SAMPLES_FILE) });
		while (!e.signal.aborted) {
			await ticker.data.tick();
			await e.deps.sleep(COLLECT_METRICS_INTERVAL_MS, e.signal);
		}
		e.set("metrics", { state: "stopped" });
	}
}

class LogsTask extends CaptureTask {
	readonly name = "logs";
	enabled(plan: PerfPlan): boolean {
		return plan.logs;
	}
	protected failedKinds(): readonly CaptureKind[] {
		return ["logs"];
	}
	protected async run(e: CaptureEnv): Promise<void> {
		const out = join(e.dir, "logs", "device.log");
		e.set("logs", { state: "running", out });
		const done = await perfLogsOps.runLogCapture(
			e.ctx,
			{ udid: e.target.udid, platform: e.target.platform },
			{ id: e.plan.app },
			out,
			e.signal,
			e.deps.logs
		);
		if (!done.success) e.deps.log(`logs: ${done.error.message}`);
		e.set("logs", { state: done.success ? "stopped" : "failed" });
	}
}

/** The Hermes CPU profile and React profile, over one inspector socket. */
class DevtoolsTask extends CaptureTask {
	readonly name = "devtools";
	enabled(plan: PerfPlan): boolean {
		return plan.js || plan.react;
	}
	protected failedKinds(plan: PerfPlan): readonly CaptureKind[] {
		return [...(plan.js ? (["js"] as const) : []), ...(plan.react ? (["react"] as const) : [])];
	}

	/** Attach to the app's Hermes runtime, polling until its target shows (a relaunched app registers late). */
	private async attach(e: CaptureEnv) {
		const waitMs = e.plan.relaunch ? RELAUNCH_TARGET_WAIT_MS : ATTACHED_TARGET_WAIT_MS;
		const deadline = e.ctx.now() + waitMs;
		for (;;) {
			const conn = await perfJsCli.connectJs(
				e.ctx,
				e.perfDeps,
				e.deps.js,
				e.target,
				{ app: e.plan.app, ...(e.plan.metroUrl === undefined ? {} : { metro: e.plan.metroUrl }) },
				CONNECT_TIMEOUT_MS
			);
			if (conn.success || e.signal.aborted || e.ctx.now() >= deadline) return conn;
			await e.deps.sleep(TARGET_POLL_MS, e.signal);
		}
	}

	/** Start the React profile over `cdp`; returns the host wall clock when it began, or undefined when it failed. */
	private async startReact(e: CaptureEnv, cdp: Cdp, owner: ReactOwner): Promise<number | undefined> {
		const started = await reactCapture.startReactCapture(cdp, { owner });
		if (!started.success) {
			e.deps.log(`react: ${started.error.message}`);
			e.set("react", { state: "failed" });
			return undefined;
		}
		e.set("react", { state: "running", out: join(e.dir, "react") });
		return e.ctx.now();
	}

	/** Run the Hermes CPU capture for `durationMs` and record its final state. */
	private async runJs(
		e: CaptureEnv,
		cdp: Cdp,
		metro: string | undefined,
		jsDir: string,
		durationMs: number
	): Promise<void> {
		const captured = await jsCaptureService.runJsCapture(cdp, {
			dir: jsDir,
			metroUrl: metro,
			fetchMap: e.deps.js.fetchMap,
			projectRoot: e.plan.cwd,
			durationMs,
			sleep: e.deps.js.sleep,
			now: e.ctx.now,
			signal: e.signal,
			onStarted: () => e.set("js", { state: "running", out: jsDir }),
		});
		if (!captured.success) e.deps.log(`js: ${captured.error.message}`);
		e.set("js", { state: captured.success ? "stopped" : "failed" });
	}

	/** Stop the React profile started at `hostWallMs` and record its final state. */
	private async stopReact(
		e: CaptureEnv,
		cdp: Cdp,
		owner: ReactOwner,
		jsDir: string,
		hostWallMs: number
	): Promise<void> {
		const stopped = await reactCapture.stopReactCapture(cdp, {
			dir: join(e.dir, "react"),
			jsDir,
			cwd: e.plan.cwd,
			sessionId: e.id,
			owner,
			hostWallMs,
		});
		if (!stopped.success) e.deps.log(`react: ${stopped.error.message}`);
		e.set("react", { state: stopped.success ? "stopped" : "failed" });
	}

	protected async run(e: CaptureEnv): Promise<void> {
		const { plan } = e;
		const kinds = this.failedKinds(plan);
		if (kinds.length === 0) return;
		const conn = await this.attach(e);
		if (!conn.success) {
			e.deps.log(`devtools: ${conn.error.message}`);
			for (const kind of kinds) e.set(kind, { state: "failed" });
			return;
		}
		const { session: cdp, metro } = conn.data;
		const jsDir = join(e.dir, JS_DIR);
		const owner = await reactCapture.reactOwner(e.ctx);
		const remaining = () => Math.max(1, e.startMs + e.maxDurationMs - e.ctx.now());
		try {
			const reactHostMs = plan.react ? await this.startReact(e, cdp, owner) : undefined;
			if (plan.js) await this.runJs(e, cdp, metro, jsDir, remaining());
			else await e.deps.sleep(remaining(), e.signal);
			if (reactHostMs !== undefined) await this.stopReact(e, cdp, owner, jsDir, reactHostMs);
		} finally {
			cdp.close();
			await perfBrokerResumeCli.settleBrokerResumes();
		}
	}
}

export type CollectOutcome = "capped" | "ended" | "missing" | "aborted";

export class PerfCollectorCli {
	private readonly tasks: readonly CaptureTask[] = [new MetricsTask(), new LogsTask(), new DevtoolsTask()];

	defaultCollectorDeps(log: (line: string) => void): CollectorDeps {
		return { js: defaultJsDeps, logs: defaultLogDeps, sleep: defaultJsDeps.sleep, log };
	}

	private capturerSink(ctx: CommandContext, id: string): Sink {
		return (kind, patch) => {
			perfSessionStore.updateSession(ctx, id, (s) => {
				const prior = s.capturers.find((c) => c.kind === kind);
				const next: Capturer = {
					kind,
					startedAtIso: prior?.startedAtIso ?? new Date(ctx.now()).toISOString(),
					state: "running",
					...(prior ?? {}),
					...patch,
				};
				return { ...s, capturers: [...s.capturers.filter((c) => c.kind !== kind), next] };
			});
		};
	}

	/**
	 * The detached `perf-collect --session <id>` body: host the session's long-lived captures (metrics every second, logs,
	 * the Hermes CPU profile and React profile over one inspector socket) until the session's cap, a stop (`signal`)
	 * or the session ending. Each capture flushes its files on the way out. When the cap ended it, run the same stop path
	 * as `perf stop` (`deps.finalize`) so the report still lands.
	 */
	async runSessionCollector(
		ctx: CommandContext,
		perfDeps: PerfDeps,
		deps: CollectorDeps,
		id: string,
		external: AbortSignal
	): Promise<Result<CollectOutcome, UiError>> {
		const session = perfSessionStore.readSession(ctx, id);
		const plan = perfPlans.readPlan(ctx, id);
		if (session === undefined || plan === undefined) return resultFactory.ok("missing");
		const inner = new AbortController();
		const forward = () => inner.abort();
		external.addEventListener("abort", forward, { once: true });
		if (external.aborted) inner.abort();
		const target: PerfTarget = {
			udid: session.device.udid,
			platform: session.device.platform,
			...(session.device.name === undefined ? {} : { name: session.device.name }),
			ownedByCaller: false,
			source: "flag",
			mode: "observe",
		};
		const env: CaptureEnv = {
			ctx,
			perfDeps,
			deps,
			id,
			plan,
			target,
			startMs: session.startedAt.wallMs,
			maxDurationMs: session.maxDurationMs,
			signal: inner.signal,
			set: this.capturerSink(ctx, id),
			dir: perfPaths.sessionDir(ctx, id),
		};
		const running = this.tasks.filter((t) => t.enabled(plan)).map((t) => t.guarded(env));
		const outcome = await autoStop.untilCap(ctx, id, {
			sleep: (ms) => deps.sleep(ms, inner.signal),
			signal: inner.signal,
		});
		inner.abort();
		await Promise.allSettled(running);
		external.removeEventListener("abort", forward);
		if (outcome === "capped" && deps.finalize !== undefined) await deps.finalize(id);
		return resultFactory.ok(outcome);
	}
}

export const perfCollectorCli = new PerfCollectorCli();
