import { join } from "node:path";
import type { Capturer } from "@delacour/warden-perf/shared/session.schema";
import { ok, type Result } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { untilCap } from "./auto-stop";
import { COLLECT_METRICS_INTERVAL_MS, createMetricsTicker } from "./collect-metrics";
import type { PerfTarget } from "./device";
import { androidFrameRate } from "./frames";
import { connectJs } from "./js";
import { defaultJsDeps, JS_DIR, type JsDeps, runJsCapture } from "./js-capture";
import { defaultLogDeps, type LogDeps, runLogCapture } from "./logs";
import { SAMPLES_FILE } from "./metrics-out";
import { sessionDir } from "./paths";
import { type PerfPlan, readPlan } from "./plan";
import { reactOwner, startReactCapture, stopReactCapture } from "./react-capture";
import type { PerfDeps } from "./run";
import { readSession, updateSession } from "./session";

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

export const defaultCollectorDeps = (log: (line: string) => void): CollectorDeps => ({
	js: defaultJsDeps,
	logs: defaultLogDeps,
	sleep: defaultJsDeps.sleep,
	log,
});

type Sink = (kind: Capturer["kind"], patch: Partial<Omit<Capturer, "kind">>) => void;

function capturerSink(ctx: CommandContext, id: string): Sink {
	return (kind, patch) => {
		updateSession(ctx, id, (s) => {
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

type Env = {
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

async function metricsTask(e: Env): Promise<void> {
	const { ctx, plan, target } = e;
	const fps =
		target.platform === "android" ? async () => (await androidFrameRate(ctx, target.udid, plan.app))?.fps : undefined;
	const ticker = await createMetricsTicker(ctx, {
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

async function logsTask(e: Env): Promise<void> {
	const out = join(e.dir, "logs", "device.log");
	e.set("logs", { state: "running", out });
	const done = await runLogCapture(
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

/** Attach to the app's Hermes runtime, polling until its target shows (a relaunched app registers late). */
async function attach(e: Env) {
	const waitMs = e.plan.relaunch ? RELAUNCH_TARGET_WAIT_MS : ATTACHED_TARGET_WAIT_MS;
	const deadline = e.ctx.now() + waitMs;
	for (;;) {
		const conn = await connectJs(
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

async function cdpTask(e: Env): Promise<void> {
	const { plan } = e;
	const kinds = [...(plan.js ? (["js"] as const) : []), ...(plan.react ? (["react"] as const) : [])];
	if (kinds.length === 0) return;
	const conn = await attach(e);
	if (!conn.success) {
		e.deps.log(`devtools: ${conn.error.message}`);
		for (const kind of kinds) e.set(kind, { state: "failed" });
		return;
	}
	const { session: cdp, metro } = conn.data;
	const jsDir = join(e.dir, JS_DIR);
	const owner = await reactOwner(e.ctx);
	const remaining = () => Math.max(1, e.startMs + e.maxDurationMs - e.ctx.now());
	try {
		let reactHostMs: number | undefined;
		if (plan.react) {
			const started = await startReactCapture(cdp, { owner });
			if (started.success) {
				reactHostMs = e.ctx.now();
				e.set("react", { state: "running", out: join(e.dir, "react") });
			} else {
				e.deps.log(`react: ${started.error.message}`);
				e.set("react", { state: "failed" });
			}
		}
		if (plan.js) {
			const captured = await runJsCapture(cdp, {
				dir: jsDir,
				metroUrl: metro,
				fetchMap: e.deps.js.fetchMap,
				projectRoot: plan.cwd,
				durationMs: remaining(),
				sleep: e.deps.js.sleep,
				now: e.ctx.now,
				signal: e.signal,
				onStarted: () => e.set("js", { state: "running", out: jsDir }),
			});
			if (!captured.success) e.deps.log(`js: ${captured.error.message}`);
			e.set("js", { state: captured.success ? "stopped" : "failed" });
		} else {
			await e.deps.sleep(remaining(), e.signal);
		}
		if (reactHostMs !== undefined) {
			const stopped = await stopReactCapture(cdp, {
				dir: join(e.dir, "react"),
				jsDir,
				cwd: plan.cwd,
				sessionId: e.id,
				owner,
				hostWallMs: reactHostMs,
			});
			if (!stopped.success) e.deps.log(`react: ${stopped.error.message}`);
			e.set("react", { state: stopped.success ? "stopped" : "failed" });
		}
	} finally {
		cdp.close();
	}
}

async function guarded(name: string, e: Env, work: (e: Env) => Promise<void>): Promise<void> {
	try {
		await work(e);
	} catch (error) {
		e.deps.log(`${name}: ${errorMessage(error)}`);
		if (name === "devtools") {
			if (e.plan.js) e.set("js", { state: "failed" });
			if (e.plan.react) e.set("react", { state: "failed" });
		} else if (name === "metrics" || name === "logs") e.set(name, { state: "failed" });
	}
}

export type CollectOutcome = "capped" | "ended" | "missing" | "aborted";

/**
 * The detached `perf-collect --session <id>` body: host the session's long-lived captures (metrics every second, logs,
 * the Hermes CPU profile and React profile over one inspector socket) until the session's cap, a stop (`signal`)
 * or the session ending. Each capture flushes its files on the way out. When the cap ended it, run the same stop path
 * as `perf stop` (`deps.finalize`) so the report still lands.
 */
export async function runSessionCollector(
	ctx: CommandContext,
	perfDeps: PerfDeps,
	deps: CollectorDeps,
	id: string,
	external: AbortSignal
): Promise<Result<CollectOutcome, UiError>> {
	const session = readSession(ctx, id);
	const plan = readPlan(ctx, id);
	if (session === undefined || plan === undefined) return ok("missing");
	const inner = new AbortController();
	const forward = () => inner.abort();
	external.addEventListener("abort", forward, { once: true });
	if (external.aborted) inner.abort();
	const set = capturerSink(ctx, id);
	const target: PerfTarget = {
		udid: session.device.udid,
		platform: session.device.platform,
		...(session.device.name === undefined ? {} : { name: session.device.name }),
		ownedByCaller: false,
		source: "flag",
		mode: "observe",
	};
	const env: Env = {
		ctx,
		perfDeps,
		deps,
		id,
		plan,
		target,
		startMs: session.startedAt.wallMs,
		maxDurationMs: session.maxDurationMs,
		signal: inner.signal,
		set,
		dir: sessionDir(ctx, id),
	};
	const tasks: Array<Promise<void>> = [];
	if (plan.metrics) tasks.push(guarded("metrics", env, metricsTask));
	if (plan.logs) tasks.push(guarded("logs", env, logsTask));
	if (plan.js || plan.react) tasks.push(guarded("devtools", env, cdpTask));
	const outcome = await untilCap(ctx, id, { sleep: (ms) => deps.sleep(ms, inner.signal), signal: inner.signal });
	inner.abort();
	await Promise.allSettled(tasks);
	external.removeEventListener("abort", forward);
	if (outcome === "capped" && deps.finalize !== undefined) await deps.finalize(id);
	return ok(outcome);
}
