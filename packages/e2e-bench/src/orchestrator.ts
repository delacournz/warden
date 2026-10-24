import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { BenchAdapter, FrameworkId, RunContext } from "./adapters/adapter.types";
import { dismissAnr, hideErrorDialogs } from "./harness/anr";
import { installApp, terminateApp } from "./harness/app";
import {
	type BenchApp,
	benchAppDir,
	ensureBenchApp,
	importBenchApp,
	readBenchApp,
	verifyBenchApp,
} from "./harness/bench-app";
import { BUNDLE_ID } from "./harness/bundle";
import { type ClaimedDevice, claimDevice, deviceInfo, heartbeatDevice, releaseDevice } from "./harness/device";
import type { Child, Exec, ExecOptions } from "./harness/exec";
import { hostInfo } from "./harness/host";
import { isolate, recordAnimationScales, restoreAnimationScales } from "./harness/isolation";
import { openPhaseLog, timed } from "./harness/phases";
import { diffResidue, type Owner, ownerFilter, snapshotResidue } from "./harness/residue";
import {
	type ExitCharge,
	groupOfArgv,
	type SamplerOptions,
	startSampler,
	type Tick,
	windowSummary,
} from "./harness/sampler";
import { cpuSeconds as fmtCpu, ms as fmtMs, pct as fmtPct, ratio as fmtRatio } from "./report/format";
import { renderMarkdown } from "./report/markdown";
import { benchSummary } from "./report/summary";
import { summaryRows } from "./report/tables";
import { footprintOf } from "./results/footprint";
import type { Manifest } from "./results/manifest";
import {
	type BenchRun,
	type FrameworkResult,
	type Host,
	type HostGroup,
	type OkFrameworkResult,
	type Phase,
	type Platform,
	type RepResult,
	SCHEMA_VERSION,
} from "./results/schema";
import { frameworkStats, withRatios } from "./results/stats";
import { writeBenchResults, writeFileAtomic } from "./results/write";

export type BenchOptions = {
	platform: Platform;
	frameworks: readonly FrameworkId[];
	runs: number;
	retries: number;
	udid?: string;
	rebootBetween: boolean;
	/** output dir; default `<repoRoot>/.bench/<timestamp>-<platform>` */
	out?: string;
	skipDoctor: boolean;
	force: boolean;
	keepDrivers: boolean;
	nodeBin?: string;
	/** a pinned bench app dir (with `manifest.json`) or a bare `.app` / `.apk` to pin; default: the pinned app */
	app?: string;
};

export type BenchDeps = {
	exec: Exec;
	now: () => Date;
	adapters: readonly BenchAdapter[];
	cliPath: string;
	repoRoot: string;
	packageRoot: string;
	manifest: Manifest;
	log: (line: string) => void;
	sleep: (ms: number) => Promise<void>;
	/** the environment frameworks inherit (`process.env`) */
	env: Record<string, string | undefined>;
	/** aborted by SIGINT / SIGTERM: the run finishes the current rep, tears down and writes what it has */
	signal?: AbortSignal;
	/** `report/html.ts`, injected so the orchestrator test does not need it */
	renderHtml?: (run: BenchRun, manifest: Manifest) => string;
	/** sampler tick interval (default 500) */
	samplerIntervalMs?: number;
	/** schedule the lease heartbeat `fn` every `ms`; returns the canceller (default `setInterval`) */
	heartbeatEvery?: (fn: () => void, ms: number) => () => void;
	/** `harness/sampler.ts` `startSampler`, injected so the orchestrator test can drive the sampler clock */
	startSampler?: (options: SamplerOptions) => ReturnType<typeof startSampler>;
};

export type BenchOutcome = { runDir: string; run: BenchRun; interrupted: boolean };

type Session = {
	opts: BenchOptions;
	deps: BenchDeps;
	runDir: string;
	device: ClaimedDevice;
	app: BenchApp;
	/** exec that records every child pid for the sampler */
	exec: Exec;
	pids: Set<number>;
	/** the host group each spawned pid was started as (`trackingExec`) */
	labels: Map<number, HostGroup>;
	/** where `trackingExec` reports a `run` child's CPU time at exit: the running sampler, if any */
	exitHook: { current?: (pid: number, cpuSec: number) => void };
	env: Record<string, string | undefined>;
	log: (line: string) => void;
};

/** True when the machine is busier than its core count; a loaded host makes every number noise. */
export function loadTooHigh(host: Pick<Host, "loadAvgAtStart" | "cores">): boolean {
	return host.loadAvgAtStart > host.cores;
}

/** `2026-10-16T12:07:32.000Z` to `2026-10-16T12-07-32`. */
export function runStamp(date: Date): string {
	return date.toISOString().slice(0, 19).replaceAll(":", "-");
}

/**
 * Wraps `base` so every spawned child's pid lands in `pids` (the sampler's root pids) and, when given,
 * `labels` records what it was spawned as (`groupOfArgv` of the command and its first argument, else
 * `other`), so the sampler can attribute a child whose own argv does not say (an `xcrun` under `warden`).
 * `onExit` gets each `run` child's CPU time at exit (`ExecResult.cpuSec`), for the sampler's exit charge.
 */
export function trackingExec(
	base: Exec,
	pids: Set<number>,
	labels?: Map<number, HostGroup>,
	onExit?: (pid: number, cpuSec: number) => void
): Exec {
	const register = (cmd: string, args: readonly string[]) => (pid: number) => {
		pids.add(pid);
		labels?.set(pid, groupOfArgv(cmd, args[0]) ?? "other");
	};
	return {
		run: async (cmd, args, options) => {
			let spawned: number | undefined;
			const own = register(cmd, args);
			const result = await base.run(cmd, args, {
				...options,
				onSpawn: chain(options, (pid) => {
					spawned = pid;
					own(pid);
				}),
			});
			if (spawned !== undefined && result.cpuSec !== undefined) onExit?.(spawned, result.cpuSec);
			return result;
		},
		start: (cmd, args, options): Child => {
			const own = register(cmd, args);
			const child = base.start(cmd, args, { ...options, onSpawn: chain(options, own) });
			own(child.pid);
			return child;
		},
		which: (cmd) => base.which(cmd),
	};
}

function chain(options: Pick<ExecOptions, "onSpawn"> | undefined, own: (pid: number) => void): (pid: number) => void {
	return (pid) => {
		own(pid);
		options?.onSpawn?.(pid);
	};
}

/** `PATH` with the node binary's directory first, so frameworks that shell out to `node` get the right one. */
function envFor(opts: BenchOptions, base: Record<string, string | undefined>): Record<string, string | undefined> {
	if (opts.nodeBin === undefined) return { ...base };
	return {
		...base,
		PATH: [dirname(opts.nodeBin), base.PATH].filter((p) => p !== undefined && p !== "").join(delimiter),
	};
}

function makeCtx(s: Session, adapter: BenchAdapter, outDir: string, cold: boolean, phaseName: string): RunContext {
	mkdirSync(outDir, { recursive: true });
	const phaseLog = openPhaseLog(s.runDir, `${adapter.id}.${phaseName}`);
	return {
		platform: s.opts.platform,
		udid: s.device.udid,
		bundleId: BUNDLE_ID,
		appPath: s.app.appPath,
		outDir,
		cold,
		retries: s.opts.retries,
		env: s.env,
		exec: s.exec,
		log: (line) => phaseLog.line(line),
		packageRoot: s.deps.packageRoot,
		repoRoot: s.deps.repoRoot,
	};
}

type Outcome =
	| { kind: "ok" }
	| { kind: "unsupported"; reason: string }
	| { kind: "failed"; phase: Phase; error: string };

type PhaseState = {
	reps: RepResult[];
	prepareMs: number;
	teardownMs: number;
	/** where the sampler appends ticks right now (per rep, or the framework dir between reps) */
	tickFile: { path: string };
	/** the sampler clock (ms since this framework's sampler started) */
	clock: () => number;
	/** per rep index: the timed `run` window on that clock */
	windows: Map<number, { startMs: number; endMs: number }>;
};

type FrameworkCtx = { s: Session; adapter: BenchAdapter; fwDir: string };

const aborted = (s: Session): boolean => s.deps.signal?.aborted === true;

async function preparePhase(fc: FrameworkCtx, st: PhaseState): Promise<Outcome> {
	const { s, adapter, fwDir } = fc;
	const ctx = makeCtx(s, adapter, fwDir, true, "prepare");
	const { result, ms } = await timed("prepare", () => adapter.prepare(ctx));
	st.prepareMs = ms;
	return result.success ? { kind: "ok" } : { kind: "failed", phase: "prepare", error: result.error };
}

async function teardownPhase(fc: FrameworkCtx, st: PhaseState): Promise<Outcome> {
	const { s, adapter, fwDir } = fc;
	st.tickFile.path = join(fwDir, "resources.ndjson");
	const ctx = makeCtx(s, adapter, fwDir, false, "teardown");
	const { result, ms } = await timed("teardown", () => adapter.teardown(ctx));
	st.teardownMs = ms;
	return result.success ? { kind: "ok" } : { kind: "failed", phase: "teardown", error: result.error };
}

/** One rep: terminate the app, run the suite, stamp the harness-measured fields on the adapter's result. */
async function repPhase(fc: FrameworkCtx, st: PhaseState, n: number): Promise<Outcome> {
	const { s, adapter, fwDir } = fc;
	const repDir = join(fwDir, `rep-${n}`);
	const ctx = makeCtx(s, adapter, repDir, n === 1, `rep-${n}`);
	st.tickFile.path = join(repDir, "resources.ndjson");
	const stopped = await terminateApp(s.exec, s.opts.platform, s.device.udid, BUNDLE_ID);
	if (!stopped.success) ctx.log(`terminate app: ${stopped.error}`);
	if (s.opts.platform === "android") {
		const anr = await dismissAnr(s.exec, s.device.udid);
		if (!anr.success) ctx.log(`anr check: ${anr.error}`);
		else if (anr.data.dismissed)
			ctx.log(`dismissed an "isn't responding" dialog for ${anr.data.packageName} before rep ${n}`);
	}
	const startedAt = s.deps.now().toISOString();
	const startMs = st.clock();
	const { result, ms } = await timed("run", () => adapter.run(ctx));
	st.windows.set(n, { startMs, endMs: st.clock() });
	if (!result.success) {
		const e = result.error;
		return e.kind === "unsupported"
			? { kind: "unsupported", reason: e.reason }
			: { kind: "failed", phase: "run", error: e.message };
	}
	st.reps.push({
		...result.data,
		index: n,
		cold: n === 1,
		wallMs: Math.round(ms * 10) / 10,
		wallSource: "harness",
		startedAt,
		rawArtifactDir: relative(s.runDir, repDir),
	});
	return { kind: "ok" };
}

async function repsPhase(fc: FrameworkCtx, st: PhaseState): Promise<Outcome> {
	for (let n = 1; n <= fc.s.opts.runs; n++) {
		if (aborted(fc.s)) return { kind: "failed", phase: "run", error: "interrupted" };
		const outcome = await repPhase(fc, st, n);
		if (outcome.kind !== "ok") return outcome;
	}
	return { kind: "ok" };
}

/** prepare, reps, then teardown no matter how the earlier phases went; the first problem wins. */
async function executeAdapter(fc: FrameworkCtx, st: PhaseState): Promise<Outcome> {
	let outcome = await preparePhase(fc, st);
	if (outcome.kind === "ok") outcome = await repsPhase(fc, st);
	const down = await teardownPhase(fc, st);
	return outcome.kind === "ok" ? down : outcome;
}

type DoctorOutcome = { kind: "ok"; version: string } | { kind: "stop"; result: FrameworkResult };

async function doctorPhase(fc: FrameworkCtx): Promise<DoctorOutcome> {
	const { s, adapter } = fc;
	if (s.opts.skipDoctor) return { kind: "ok", version: "unknown" };
	const ctx = makeCtx(s, adapter, fc.fwDir, true, "doctor");
	const d = await adapter.doctor(ctx);
	if (d.ok) return { kind: "ok", version: d.version };
	const reason = `${d.reason} (${d.installHint})`;
	const result: FrameworkResult = {
		framework: adapter.id,
		status: "failed",
		version: "unknown",
		phase: "doctor",
		error: reason,
	};
	return { kind: "stop", result };
}

function toResult(
	outcome: Outcome,
	framework: FrameworkId,
	version: string,
	reps: RepResult[]
): FrameworkResult | undefined {
	if (outcome.kind === "unsupported") return { framework, status: "unsupported", version, reason: outcome.reason };
	if (outcome.kind === "failed")
		return {
			framework,
			status: "failed",
			version,
			phase: outcome.phase,
			error: outcome.error,
			...(reps.length > 0 ? { partial: reps } : {}),
		};
	return undefined;
}

/** Runs one framework end to end and returns its result; never throws for adapter problems. */
async function runFramework(
	s: Session,
	adapter: BenchAdapter,
	previous: BenchAdapter | undefined
): Promise<FrameworkResult> {
	const { opts, deps, device } = s;
	const fwDir = join(s.runDir, "artifacts", adapter.id);
	mkdirSync(fwDir, { recursive: true });
	const fc: FrameworkCtx = { s, adapter, fwDir };
	if (!adapter.supports.includes(opts.platform))
		return { framework: adapter.id, status: "unsupported", reason: `does not support ${opts.platform}` };
	const doctor = await doctorPhase(fc);
	if (doctor.kind === "stop") return doctor.result;
	const isolated = await isolate({
		exec: deps.exec,
		platform: opts.platform,
		udid: device.udid,
		bundleId: BUNDLE_ID,
		...(previous !== undefined ? { previous } : {}),
		next: adapter,
		allDrivers: deps.adapters.flatMap((a) => a.residuePatterns.driverBundleIds),
		cold: !opts.keepDrivers,
		rebootBetween: opts.rebootBetween,
		log: s.log,
		repoRoot: deps.repoRoot,
		cliPath: deps.cliPath,
		benchPids: () => [...s.pids],
		ownedPaths: ownedPathsOf(s),
		sleep: deps.sleep,
	});
	if (!isolated.success)
		return {
			framework: adapter.id,
			status: "failed",
			version: doctor.version,
			phase: "prepare",
			error: `isolation: ${isolated.error}`,
		};
	return measure(fc, doctor.version);
}

/** Directories only this bench writes to: the run dir, agent-device bench state, warden's simd dir for the device. */
function ownedPathsOf(s: Session): string[] {
	const wardenHome = process.env.WARDEN_HOME ?? join(homedir(), ".warden");
	return [s.runDir, join(homedir(), ".agent-device-bench"), join(wardenHome, "simd", s.device.udid)];
}

/** The measured part: residue snapshot, sampler, phases, then residue / footprint / stats. */
async function measure(fc: FrameworkCtx, version: string): Promise<FrameworkResult> {
	const { s, adapter, fwDir } = fc;
	const probe = {
		exec: s.deps.exec,
		platform: s.opts.platform,
		udid: s.device.udid,
		patterns: adapter.residuePatterns,
	};
	const owner: Owner = { udid: s.device.udid, benchPids: () => [...s.pids], ownedPaths: ownedPathsOf(s) };
	const before = await snapshotResidue(probe);
	const tickFile = { path: join(fwDir, "resources.ndjson") };
	const sampler = (s.deps.startSampler ?? startSampler)({
		exec: s.deps.exec,
		rootPids: () => [...s.pids],
		rootLabels: () => s.labels,
		processPatterns: adapter.residuePatterns.processes,
		owned: (rows) => ownerFilter(rows, owner),
		simUdid: s.device.udid,
		platform: s.opts.platform,
		...(s.deps.samplerIntervalMs !== undefined ? { intervalMs: s.deps.samplerIntervalMs } : {}),
		sink: (tick: Tick) => appendTick(tickFile.path, tick),
		log: (line: string) => s.log(`${adapter.id}: ${line}`),
	});
	// exit CPU only for children spawned while this sampler runs (an older child's rusage predates it)
	const spawnedBefore = new Set(s.pids);
	s.exitHook.current = (pid, cpuSec) => {
		if (!spawnedBefore.has(pid)) sampler.exited(pid, cpuSec);
	};
	const st: PhaseState = {
		reps: [],
		prepareMs: 0,
		teardownMs: 0,
		tickFile,
		clock: () => sampler.elapsed(),
		windows: new Map(),
	};
	let outcome: Outcome;
	try {
		outcome = await executeAdapter(fc, st);
	} catch (e) {
		outcome = { kind: "failed", phase: "run", error: e instanceof Error ? e.message : String(e) };
	}
	s.exitHook.current = undefined;
	const { ticks, exits, ...resources } = await sampler.stop();
	st.reps = withRepResources(st.reps, st.windows, ticks, exits);
	const problem = toResult(outcome, adapter.id, version, st.reps);
	if (problem !== undefined) return problem;
	const residue = await diffResidue({ ...probe, owner, before });
	const footprint = await footprintOf({ packageRoot: s.deps.packageRoot, framework: adapter.id, exec: s.deps.exec });
	return {
		framework: adapter.id,
		status: "ok",
		version,
		phases: { prepareMs: st.prepareMs, teardownMs: st.teardownMs },
		reps: st.reps,
		resources,
		residue,
		footprint,
		stats: frameworkStats({ reps: st.reps, prepareMs: st.prepareMs, teardownMs: st.teardownMs }),
	};
}

/** Each rep with the resources of its own timed-run window (`resources` = the whole framework, "whole-framework"). */
function withRepResources(
	reps: readonly RepResult[],
	windows: ReadonlyMap<number, { startMs: number; endMs: number }>,
	ticks: readonly Tick[],
	exits: readonly ExitCharge[]
): RepResult[] {
	return reps.map((r) => {
		const w = windows.get(r.index);
		return w === undefined ? r : { ...r, resources: windowSummary(ticks, w.startMs, w.endMs, exits) };
	});
}

function appendTick(path: string, tick: Tick): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(tick)}\n`);
}

const isOk = (f: FrameworkResult): f is OkFrameworkResult => f.status === "ok";

/** Cross-framework ratios over the ok frameworks; others pass through. */
export function finalizeFrameworks(frameworks: readonly FrameworkResult[]): FrameworkResult[] {
	const ratioed = new Map(withRatios(frameworks.filter(isOk)).map((f) => [f.framework, f]));
	return frameworks.map((f) => (isOk(f) ? (ratioed.get(f.framework) ?? f) : f));
}

/** Writes report.md, summary.json (the docs page data) and report.html (when a renderer is injected) next to bench-results.json. */
export function writeReports(runDir: string, run: BenchRun, deps: Pick<BenchDeps, "manifest" | "renderHtml">): void {
	writeFileAtomic(join(runDir, "report.md"), renderMarkdown(run, deps.manifest));
	writeFileAtomic(join(runDir, "summary.json"), `${JSON.stringify(benchSummary(run, deps.manifest), null, "\t")}\n`);
	if (deps.renderHtml !== undefined) writeFileAtomic(join(runDir, "report.html"), deps.renderHtml(run, deps.manifest));
}

/** A short console table of the summary rows. */
export function summaryLines(run: BenchRun): string[] {
	const summary = summaryRows(run);
	// the CPU-seconds column only when some framework has one (else the pre-19-6 layout)
	const withCpu = summary.some((r) => r.cpuSecondsPerRep !== undefined);
	const header = ["framework", "status", "version", "median", "ratio", "pass", "flake", "cold start"];
	if (withCpu) header.push("cpu-s/rep");
	const rows = summary.map((r) => [
		r.framework,
		r.status,
		r.version ?? "-",
		fmtMs(r.suiteMedianMs),
		fmtRatio(r.ratio),
		fmtPct(r.passRate),
		fmtPct(r.flakeRate),
		fmtMs(r.coldStartMs),
		...(withCpu ? [fmtCpu(r.cpuSecondsPerRep)] : []),
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cols: readonly string[]) =>
		cols
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)];
}

const HEARTBEAT_MS = 60_000;

/**
 * Heartbeats the bench's own lease every 60 s for the whole run (a framework's reps make no warden call
 * for minutes). Uses the untracked exec, so the heartbeat processes never count as framework load. A
 * failed heartbeat is logged and the run goes on (the 4 h TTL still holds the lease).
 */
function startHeartbeat(deps: BenchDeps, leaseId: string): () => void {
	const every =
		deps.heartbeatEvery ??
		((fn: () => void, ms: number) => {
			const handle = setInterval(fn, ms);
			return () => clearInterval(handle);
		});
	return every(() => {
		void heartbeatDevice(deps.exec, { cliPath: deps.cliPath, leaseId, repoRoot: deps.repoRoot }).then((r) => {
			if (!r.success) deps.log(`heartbeat ${leaseId} failed: ${r.error}`);
		});
	}, HEARTBEAT_MS);
}

function startCaffeinate(exec: Exec, log: (line: string) => void): Child | undefined {
	try {
		return exec.start("caffeinate", ["-dims"]);
	} catch (e) {
		log(`caffeinate unavailable: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

type Prepared = {
	host: Host;
	device: ClaimedDevice;
	info: { name?: string; runtime?: string };
	app: BenchApp;
};

/** `--app`: a pinned dir is used as is, a bare `.app` / `.apk` is pinned first. */
async function appFromPath(
	opts: BenchOptions,
	deps: BenchDeps,
	path: string
): AsyncResult<BenchApp & { reused: boolean }> {
	const dir = resolve(path);
	if (existsSync(join(dir, "manifest.json"))) {
		const read = readBenchApp(dir);
		if (!read.success) return read;
		return read.data.manifest.platform === opts.platform
			? ok({ ...read.data, reused: true })
			: err(`bench app at ${dir} is for ${read.data.manifest.platform}, not ${opts.platform}`);
	}
	const imported = await importBenchApp({
		path: dir,
		platform: opts.platform,
		dir: benchAppDir(deps.repoRoot, opts.platform),
		now: deps.now,
	});
	return imported.success ? ok({ ...imported.data, reused: false }) : imported;
}

/** The pinned bench app, verified; built or pinned first when missing or passed with `--app`. */
async function resolveApp(opts: BenchOptions, deps: BenchDeps): AsyncResult<BenchApp> {
	const found =
		opts.app !== undefined
			? await appFromPath(opts, deps, opts.app)
			: await ensureBenchApp(deps.exec, {
					platform: opts.platform,
					repoRoot: deps.repoRoot,
					cliPath: deps.cliPath,
					force: false,
					eas: false,
					now: deps.now,
					log: deps.log,
				});
	if (!found.success) return found;
	const verified = verifyBenchApp(found.data);
	if (!verified.success) return verified;
	const { manifest, appPath, reused } = found.data;
	deps.log(
		`app: pinned ${appPath} (hash ${manifest.hash}, source ${manifest.source}, built ${manifest.builtAt}, ${reused ? "reused" : "built now"})`
	);
	return ok({ manifest, appPath });
}

/** Host, device, app: everything before the first framework. Errors abort the run. */
async function prepareRun(
	opts: BenchOptions,
	deps: BenchDeps,
	claimed: { device?: ClaimedDevice; stopHeartbeat?: () => void }
): AsyncResult<Prepared> {
	const host = await hostInfo(deps.exec, { cliPath: deps.cliPath });
	if (!host.success) return host;
	if (loadTooHigh(host.data) && !opts.force)
		return err(
			`host load ${host.data.loadAvgAtStart.toFixed(2)} exceeds ${host.data.cores} cores; wait for idle or pass --force`
		);
	const app = await resolveApp(opts, deps);
	if (!app.success) return app;
	const device = await claimDevice(deps.exec, {
		platform: opts.platform,
		cliPath: deps.cliPath,
		repoRoot: deps.repoRoot,
		...(opts.udid !== undefined ? { udid: opts.udid } : {}),
		log: deps.log,
	});
	if (!device.success) return device;
	claimed.device = device.data;
	if (device.data.leaseId !== undefined) claimed.stopHeartbeat = startHeartbeat(deps, device.data.leaseId);
	if (opts.platform === "android") {
		const hidden = await hideErrorDialogs(deps.exec, device.data.udid, true);
		if (!hidden.success) deps.log(`hide_error_dialogs: ${hidden.error}`);
		const scales = await recordAnimationScales(deps.exec, device.data.udid);
		if (!scales.success) deps.log(`animation scales: ${scales.error}`);
	}
	const info = await deviceInfo(deps.exec, opts.platform, device.data.udid);
	const installed = await installApp(deps.exec, opts.platform, device.data.udid, app.data.appPath);
	if (!installed.success) return err(`install app: ${installed.error}`);
	return ok({ host: host.data, device: device.data, info: info.success ? info.data : {}, app: app.data });
}

function skeleton(opts: BenchOptions, deps: BenchDeps, runId: string, p: Prepared, caffeinated: boolean): BenchRun {
	return {
		schemaVersion: SCHEMA_VERSION,
		id: runId,
		startedAt: deps.now().toISOString(),
		host: p.host,
		device: {
			platform: opts.platform,
			udid: p.device.udid,
			...(p.info.name !== undefined || p.device.name !== undefined ? { name: p.info.name ?? p.device.name } : {}),
			...(p.info.runtime !== undefined ? { runtime: p.info.runtime } : {}),
			...(p.device.leaseId !== undefined ? { leaseId: p.device.leaseId } : {}),
		},
		app: {
			bundleId: BUNDLE_ID,
			appPath: p.app.appPath,
			hash: p.app.manifest.hash,
			sha256: p.app.manifest.sha256,
			bytes: p.app.manifest.bytes,
		},
		options: {
			runs: opts.runs,
			retries: opts.retries,
			rebootBetween: opts.rebootBetween,
			frameworks: [...opts.frameworks],
			caffeinated,
		},
		frameworks: [],
	};
}

/** Frameworks to run, in `opts.frameworks` order; one without an adapter is reported as failed in doctor. */
async function runAll(s: Session, run: BenchRun): Promise<boolean> {
	let previous: BenchAdapter | undefined;
	for (const id of s.opts.frameworks) {
		if (aborted(s)) return true;
		const adapter = s.deps.adapters.find((a) => a.id === id);
		s.log(`== ${id}`);
		if (adapter === undefined) {
			run.frameworks.push({
				framework: id,
				status: "failed",
				version: "unknown",
				phase: "doctor",
				error: "no adapter registered",
			});
		} else {
			run.frameworks.push(await runFramework(s, adapter, previous));
			previous = adapter;
		}
		writeBenchResults(s.runDir, run);
		const last = run.frameworks.at(-1);
		s.log(`${id}: ${last?.status}`);
	}
	return aborted(s);
}

/**
 * The whole benchmark: host + load check, caffeinate, claim, pinned app install, then every framework in order
 * with results written after each one. Always releases the lease it claimed (exactly once) and stops
 * caffeinate, including after a signal or an error.
 */
export async function runBench(opts: BenchOptions, deps: BenchDeps): AsyncResult<BenchOutcome> {
	const caffeinate = startCaffeinate(deps.exec, deps.log);
	const claimed: { device?: ClaimedDevice; stopHeartbeat?: () => void } = {};
	try {
		const prepared = await prepareRun(opts, deps, claimed);
		if (!prepared.success) return prepared;
		const stamp = `${runStamp(deps.now())}-${opts.platform}`;
		const runDir = resolve(opts.out ?? join(deps.repoRoot, ".bench", stamp));
		mkdirSync(join(runDir, "logs"), { recursive: true });
		mkdirSync(join(runDir, "artifacts"), { recursive: true });
		const benchLog = openPhaseLog(runDir, "bench");
		const log = (line: string): void => {
			deps.log(line);
			benchLog.line(line);
		};
		const run = skeleton(opts, deps, basename(runDir), prepared.data, caffeinate !== undefined);
		writeBenchResults(runDir, run);
		const pids = new Set<number>();
		const labels = new Map<number, HostGroup>();
		const exitHook: Session["exitHook"] = {};
		const session: Session = {
			opts,
			deps,
			runDir,
			device: prepared.data.device,
			app: prepared.data.app,
			exec: trackingExec(deps.exec, pids, labels, (pid, cpuSec) => exitHook.current?.(pid, cpuSec)),
			pids,
			labels,
			exitHook,
			env: envFor(opts, deps.env),
			log,
		};
		const interrupted = await runAll(session, run);
		const finished: BenchRun = {
			...run,
			frameworks: finalizeFrameworks(run.frameworks),
			endedAt: deps.now().toISOString(),
		};
		writeBenchResults(runDir, finished);
		writeReports(runDir, finished, deps);
		for (const line of summaryLines(finished)) deps.log(line);
		deps.log(`results: ${runDir}`);
		return ok({ runDir, run: finished, interrupted });
	} finally {
		claimed.stopHeartbeat?.();
		caffeinate?.kill();
		if (claimed.device !== undefined && opts.platform === "android") {
			const shown = await hideErrorDialogs(deps.exec, claimed.device.udid, false);
			if (!shown.success) deps.log(`hide_error_dialogs restore: ${shown.error}`);
			const scales = await restoreAnimationScales(deps.exec, claimed.device.udid);
			if (!scales.success) deps.log(`animation scales restore: ${scales.error}`);
		}
		if (claimed.device?.leaseId !== undefined) {
			const released = await releaseDevice(deps.exec, {
				cliPath: deps.cliPath,
				leaseId: claimed.device.leaseId,
				repoRoot: deps.repoRoot,
			});
			if (!released.success) deps.log(`release failed: ${released.error}`);
		}
	}
}
