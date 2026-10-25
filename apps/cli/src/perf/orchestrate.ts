import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { crashFindings } from "@delacour/warden-perf/logs/crash-findings";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import { clampMaxDuration } from "@delacour/warden-perf/shared/caps";
import type { PerfReportJson } from "@delacour/warden-perf/shared/report";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { slowStartupFinding } from "@delacour/warden-perf/startup/findings";
import { summarize } from "@delacour/warden-perf/startup/stats";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import { writeFileAtomic } from "../agent-ui/state";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { errorMessage } from "../hooks/json";
import { resolveApp } from "./app";
import { readClockOffsetMs } from "./clock";
import { type CrashOut, readCrashes } from "./crashes";
import { type PerfTarget, resolvePerfDevice } from "./device";
import { captureSessionFrames, resetFrameCounters } from "./frames";
import { defaultNativeProfilers, type NativeProfilers, startNative, stopNative } from "./native";
import { readHandleFile, sessionNativeDir } from "./native-state";
import { defaultNativeIo, type NativeIo } from "./native-types";
import { sessionDir } from "./paths";
import { type PerfPlan, readPlan, updatePlan, writePlan } from "./plan";
import { type LaunchResult, launchApp, resetAppData, terminateApp } from "./relaunch";
import { CRASH_SUMMARY, nativeSummaryOf, writeNativeSummary, writeSessionReport } from "./report-read";
import type { PerfDeps, PerfOptionValues } from "./run";
import {
	createSession,
	readSession,
	type StopReason,
	signalCollector,
	stopSession,
	sweepSessions,
	updateSession,
} from "./session";

/** Effects `perf start|stop` reach the host through: the native recorder's (`NativeIo`) plus how to re-run warden. */
export type SessionIo = NativeIo & { self: () => string[] };

export const defaultSessionIo: SessionIo = { ...defaultNativeIo, self: selfCommand };

/** Everything the orchestrator needs beyond `PerfDeps`. */
export type SessionKit = { io: SessionIo; profilers: NativeProfilers };

export const defaultSessionKit: SessionKit = { io: defaultSessionIo, profilers: defaultNativeProfilers };

/** How long `start` waits for the collector to arm its captures before returning anyway. */
const ARM_WAIT_MS = 20_000;
const POLL_MS = 250;
/** How long `stop` waits for the collector to flush its files after SIGTERM. */
const COLLECTOR_EXIT_WAIT_MS = 30_000;

export type StartFlags = {
	js?: boolean;
	react?: boolean;
	/** `--native` (true) or `--native=perfetto|simpleperf` */
	native?: boolean | string;
	metrics?: boolean;
	frames?: boolean;
	logs?: boolean;
	all?: boolean;
	relaunch?: boolean;
	reset?: boolean;
	maxDuration?: string;
	yes?: boolean;
};

export type StartOptions = PerfOptionValues & StartFlags;

export type CapturerChoice = {
	metrics: boolean;
	frames: boolean;
	logs: boolean;
	js: boolean;
	react: boolean;
	native?: { flavor: string };
};

const NATIVE_FLAVORS = ["perfetto", "simpleperf"];

/** The capturers a flag set asks for: `--all` is every one; none named is metrics + frames + logs (cheap, observe-only). */
export function chooseCapturers(flags: StartFlags): Result<CapturerChoice, UiError> {
	const flavor = typeof flags.native === "string" ? flags.native : "";
	if (flavor !== "" && !NATIVE_FLAVORS.includes(flavor)) {
		return {
			success: false,
			error: uiError("usage", `--native must be one of ${NATIVE_FLAVORS.join(", ")}, got "${flavor}"`),
		};
	}
	const named = [flags.js, flags.react, flags.native, flags.metrics, flags.frames, flags.logs].some(
		(f) => f !== undefined && f !== false
	);
	if (flags.all !== true && !named) return ok({ metrics: true, frames: true, logs: true, js: false, react: false });
	const all = flags.all === true;
	return ok({
		metrics: all || flags.metrics === true,
		frames: all || flags.frames === true,
		logs: all || flags.logs === true,
		js: all || flags.js === true,
		react: all || flags.react === true,
		...(all || (flags.native !== undefined && flags.native !== false) ? { native: { flavor } } : {}),
	});
}

export type StartOutcome = {
	session: PerfSession;
	plan: PerfPlan;
	warnings: string[];
	launch?: LaunchResult;
	/** the lease `start` took for the session (given back by `stop`) */
	leaseId?: string;
};

const iso = (ctx: CommandContext): string => new Date(ctx.now()).toISOString();

function failCapturer(ctx: CommandContext, id: string, kind: PerfSession["capturers"][number]["kind"]): void {
	updateSession(ctx, id, (s) => ({
		...s,
		capturers: [
			...s.capturers.filter((c) => c.kind !== kind),
			{ kind, startedAtIso: iso(ctx), state: "failed" as const },
		],
	}));
}

async function giveBackLease(ctx: CommandContext, id: string): Promise<void> {
	const plan = readPlan(ctx, id);
	if (plan?.leaseId === undefined) return;
	await releaseDevices(ctx, [plan.leaseId], { touch: false });
	updatePlan(ctx, id, (p) => ({ ...p, leaseId: undefined }));
}

/** Abandon a session whose start failed: mark it aborted and give back any lease taken. */
async function abortStart(ctx: CommandContext, deps: PerfDeps, id: string): Promise<void> {
	stopSession(ctx, deps.session, id, "stale");
	await giveBackLease(ctx, id);
}

/** Wait until every capture the collector hosts has said whether it armed (running or failed). */
async function awaitArmed(ctx: CommandContext, io: SessionIo, id: string, plan: PerfPlan): Promise<string[]> {
	const expected = [
		...(plan.metrics ? ["metrics"] : []),
		...(plan.logs ? ["logs"] : []),
		...(plan.js ? ["js"] : []),
		...(plan.react ? ["react"] : []),
	];
	if (expected.length === 0) return [];
	const deadline = ctx.now() + ARM_WAIT_MS;
	for (;;) {
		const caps = readSession(ctx, id)?.capturers ?? [];
		const pending = expected.filter((k) => !caps.some((c) => c.kind === k));
		if (pending.length === 0) return [];
		if (ctx.now() >= deadline) return pending;
		await io.sleep(POLL_MS);
	}
}

function writeLaunchStartup(
	ctx: CommandContext,
	id: string,
	target: PerfTarget,
	app: string,
	launch: Extract<LaunchResult, { kind: "launched" }>
): void {
	const totalMs = launch.am?.totalMs ?? launch.wallMs;
	const stats = summarize([totalMs]);
	const method = target.platform === "android" ? "am-start" : "simctl-approx";
	const finding = slowStartupFinding(method, stats, true);
	const doc = {
		version: 1,
		method,
		appId: app,
		device: { udid: target.udid, platform: target.platform, name: target.name },
		startedAt: ctx.now(),
		runs: [
			{ index: 1, kind: "cold", totalMs, ...(launch.am?.waitMs === undefined ? {} : { waitMs: launch.am.waitMs }) },
		],
		summary: stats === undefined ? {} : { cold: stats },
		marks: [],
		notes: ["one cold launch, timed by perf start --relaunch (warden perf startup --runs 5 for a median)"],
		findings: finding === undefined ? [] : [finding],
	};
	mkdirSync(join(sessionDir(ctx, id), "metrics"), { recursive: true });
	writeFileAtomic(join(sessionDir(ctx, id), "metrics", "startup.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

type ResolvedApp = Extract<Awaited<ReturnType<typeof resolveApp>>, { success: true }>["data"];

/** Everything the post-session start steps share. */
type StartRun = {
	ctx: CommandContext;
	deps: PerfDeps;
	kit: SessionKit;
	target: PerfTarget;
	working: PerfTarget;
	appId: string;
	opts: StartOptions;
	caps: CapturerChoice;
	capMs: number;
	id: string;
	warnings: string[];
};

/** Parse `--max-duration`; `undefined` data when the flag is absent. */
function requestedMaxDuration(raw: string | undefined): Result<number | undefined, UiError> {
	if (raw === undefined) return ok(undefined);
	const ms = parseDuration(raw);
	if (ms === undefined) {
		return {
			success: false,
			error: uiError("usage", `--max-duration must be a duration like 30s or 2m, got "${raw}"`),
		};
	}
	return ok(ms);
}

/** Drop or warn about capturers the platform cannot run (simpleperf and frames on iOS). */
function adjustForPlatform(caps: CapturerChoice, platform: PerfTarget["platform"], warnings: string[]): void {
	if (caps.native?.flavor === "simpleperf" && platform === "ios")
		warnings.push("--native=simpleperf is Android only: iOS records with xctrace");
	if (caps.frames && platform === "ios") {
		warnings.push("frames: the iOS simulator has no frame API; hangs come from --native");
		caps.frames = false;
	}
}

/** A foreign-device error gets the `--relaunch` hint; any other error passes through. */
function relaunchDeviceError(e: UiError): UiError {
	if (e.code !== "device_foreign") return e;
	return uiError("device_foreign", e.message, {
		hint: "--relaunch / --reset restart the app, so they need a device you hold or a free one; claim another with warden claim",
	});
}

/** `--relaunch` mutates the app, so resolve a device the caller holds (or a free one to lease); else observe as-is. */
async function leaseForRelaunch(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: StartOptions,
	target: PerfTarget
): Promise<Result<{ working: PerfTarget; tookLease: boolean }, UiError>> {
	if (opts.relaunch !== true) return ok({ working: target, tookLease: false });
	const resolved = await resolvePerfDevice(
		ctx,
		{ ...opts, lease: undefined, serial: undefined, udid: target.udid, claim: true },
		"mutate",
		deps.device
	);
	if (!resolved.success) return { success: false, error: relaunchDeviceError(resolved.error) };
	const working = resolved.data;
	return ok({
		working,
		tookLease: working.lease !== undefined && !target.ownedByCaller && target.holder === undefined,
	});
}

/** Open the session record; when that fails, give back a lease `start` took. */
async function openSession(
	ctx: CommandContext,
	deps: PerfDeps,
	input: {
		target: PerfTarget;
		working: PerfTarget;
		app: ResolvedApp;
		capMs: number;
		offset: number | undefined;
		tookLease: boolean;
	}
): Promise<Result<PerfSession, UiError>> {
	const { target, working, offset } = input;
	const created = createSession(ctx, deps.session, {
		device: {
			udid: target.udid,
			platform: target.platform,
			...(target.name === undefined ? {} : { name: target.name }),
		},
		target: {
			udid: target.udid,
			...(working.holder === undefined ? {} : { holder: working.holder }),
			ownedByCaller: working.ownedByCaller,
		},
		app: input.app,
		maxDurationMs: input.capMs,
		...(offset === undefined ? {} : { deviceWallMs: ctx.now() + offset }),
	});
	if (!created.success && input.tookLease && working.lease !== undefined)
		await releaseDevices(ctx, [working.lease.id], { touch: false });
	return created;
}

/** Locate Metro for JS / React; without one, mark both capturers failed, turn them off and warn. */
async function findMetro(
	ctx: CommandContext,
	deps: PerfDeps,
	target: PerfTarget,
	caps: CapturerChoice,
	id: string,
	warnings: string[]
): Promise<string | undefined> {
	if (!caps.js && !caps.react) return undefined;
	const metroUrl = await deps.host.metro(ctx, target.udid).catch(() => undefined);
	if (metroUrl !== undefined) return metroUrl;
	warnings.push("js/react: no Metro found for this device (release build, or no dev client running)");
	if (caps.js) failCapturer(ctx, id, "js");
	if (caps.react) failCapturer(ctx, id, "react");
	caps.js = false;
	caps.react = false;
	return undefined;
}

/** The plan the detached collector reads back. */
function buildPlan(
	ctx: CommandContext,
	opts: StartOptions,
	appId: string,
	caps: CapturerChoice,
	metroUrl: string | undefined,
	leaseId: string | undefined
): PerfPlan {
	return {
		version: 1,
		app: appId,
		cwd: ctx.cwd,
		metrics: caps.metrics,
		frames: caps.frames,
		logs: caps.logs,
		js: caps.js,
		react: caps.react,
		...(caps.native === undefined ? {} : { native: caps.native }),
		relaunch: opts.relaunch === true,
		...(metroUrl === undefined ? {} : { metroUrl }),
		...(leaseId === undefined ? {} : { leaseId }),
	};
}

/** Spawn the detached collector and record it as a capturer of the session. */
function spawnCollector(run: StartRun): void {
	const { ctx, kit, id } = run;
	const { pid } = kit.io.spawnDetached({
		argv: [...kit.io.self(), "perf-collect", "--session", id],
		logPath: join(sessionDir(ctx, id), "collector.log"),
	});
	updateSession(ctx, id, (s) => ({
		...s,
		capturers: [
			...s.capturers.filter((c) => c.kind !== "collector"),
			{ kind: "collector", pid, startedAtIso: iso(ctx), state: "running" },
		],
	}));
}

/** Start the native recorder when asked; a failure is a warning plus a failed capturer, not an abort. */
async function startNativeNow(run: StartRun): Promise<void> {
	const { ctx, deps, kit, caps, id } = run;
	if (caps.native === undefined) return;
	const started = await startNative(
		ctx,
		deps,
		kit.io,
		kit.profilers,
		run.working,
		{
			app: run.appId,
			leaks: false,
			...(caps.native.flavor === "" ? {} : { flavor: caps.native.flavor }),
			maxDurationMs: run.capMs,
		},
		readSession(ctx, id)
	);
	if (started.success) return;
	run.warnings.push(`native: ${started.error.message}`);
	failCapturer(ctx, id, "native");
}

/** The `StartFailure` for a failed cold launch. */
function launchFailure(launch: Extract<LaunchResult, { kind: "failed" }>): StartFailure {
	return new StartFailure(
		uiError(launch.reason === "no_launcher" ? "app_not_found" : "failed", launch.message, {
			...(launch.hint === undefined ? {} : { hint: launch.hint }),
		})
	);
}

/** Terminate the app (and wipe its data on `--reset`) ahead of a cold launch. */
async function terminateForRelaunch(run: StartRun): Promise<void> {
	const { ctx, target, appId } = run;
	const device = { platform: target.platform, id: target.udid };
	const stopped = await terminateApp(ctx, device, appId);
	if (!stopped.success) throw new StartFailure(stopped.error);
	if (run.opts.reset !== true) return;
	const wiped = await resetAppData(ctx, device, appId);
	if (!wiped.success) throw new StartFailure(wiped.error);
}

/** `--relaunch`: terminate, optionally reset, arm Android recorders, cold-launch, time it, arm the iOS recorder. */
async function relaunchApp(run: StartRun): Promise<LaunchResult> {
	const { ctx, target, appId } = run;
	await terminateForRelaunch(run);
	if (target.platform === "android") {
		await startNativeNow(run);
		if (run.caps.frames) await resetFrameCounters(ctx, target.udid, appId);
	}
	const launch = await launchApp(ctx, { platform: target.platform, id: target.udid }, appId, { cold: true });
	if (launch.kind === "failed") throw launchFailure(launch);
	writeLaunchStartup(ctx, run.id, target, appId, launch);
	if (target.platform === "ios") await startNativeNow(run);
	return launch;
}

/** Spawn the collector, relaunch / arm the native recorder, wait for the captures to arm and report the outcome. */
async function armSession(run: StartRun, plan: PerfPlan, session: PerfSession): Promise<Result<StartOutcome, UiError>> {
	const { ctx, kit, id, warnings } = run;
	spawnCollector(run);
	let launch: LaunchResult | undefined;
	if (run.opts.relaunch === true) launch = await relaunchApp(run);
	else await startNativeNow(run);
	const pending = await awaitArmed(ctx, kit.io, id, plan);
	if (pending.length > 0)
		warnings.push(`${pending.join(", ")}: still arming (see warden perf ls; the collector keeps trying)`);
	const fresh = readSession(ctx, id) ?? session;
	return ok({
		session: fresh,
		plan,
		warnings,
		...(launch === undefined ? {} : { launch }),
		...(plan.leaseId === undefined ? {} : { leaseId: plan.leaseId }),
	});
}

/**
 * Begin a perf session on `target`: sweep stale sessions, open the session (one per device), record the clock anchor,
 * arm what can be armed before the app starts (the Android recorder, logs), relaunch or reset the app when asked,
 * arm the rest (iOS recorder, Hermes and React over Metro) and start the detached collector that hosts the long-lived
 * captures and the auto-stop timer.
 *
 * `--relaunch` / `--reset` mutate the app, so they need a lease: the caller's own, or a free device (a short
 * `warden perf` lease is taken and `stop` gives it back); a device someone else holds is `device_foreign`.
 */
export async function startPerf(
	ctx: CommandContext,
	deps: PerfDeps,
	kit: SessionKit,
	target: PerfTarget,
	input: StartOptions
): Promise<Result<StartOutcome, UiError>> {
	const opts: StartOptions = input.reset === true && input.relaunch !== true ? { ...input, relaunch: true } : input;
	const choice = chooseCapturers(opts);
	if (!choice.success) return choice;
	const requested = requestedMaxDuration(opts.maxDuration);
	if (!requested.success) return requested;
	const cap = clampMaxDuration(requested.data);
	const warnings: string[] = cap.warning === undefined ? [] : [cap.warning];
	const caps = choice.data;
	adjustForPlatform(caps, target.platform, warnings);

	sweepSessions(ctx, deps.session);
	const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
	if (!app.success) return app;

	const leased = await leaseForRelaunch(ctx, deps, opts, target);
	if (!leased.success) return leased;
	const { working, tookLease } = leased.data;

	const offset = await readClockOffsetMs(ctx, { platform: target.platform, id: target.udid });
	const created = await openSession(ctx, deps, { target, working, app: app.data, capMs: cap.ms, offset, tookLease });
	if (!created.success) return created;
	const session = created.data;
	const id = session.id;
	if (offset === undefined && target.platform === "android")
		warnings.push("could not read the device clock: JS and React times are aligned by the host clock only");

	const metroUrl = await findMetro(ctx, deps, target, caps, id, warnings);
	const leaseId = tookLease ? working.lease?.id : undefined;
	const plan = buildPlan(ctx, opts, app.data.id, caps, metroUrl, leaseId);
	writePlan(ctx, id, plan);

	const run: StartRun = {
		ctx,
		deps,
		kit,
		target,
		working,
		appId: app.data.id,
		opts,
		caps,
		capMs: cap.ms,
		id,
		warnings,
	};
	try {
		return await armSession(run, plan, session);
	} catch (error) {
		signalCollector(deps.session, readSession(ctx, id) ?? session);
		await abortStart(ctx, deps, id);
		return {
			success: false,
			error: error instanceof StartFailure ? error.error : uiError("failed", errorMessage(error)),
		};
	}
}

class StartFailure extends Error {
	constructor(readonly error: UiError) {
		super(error.message);
	}
}

export type StopOptions = {
	reason: StopReason;
	/** build `report.md` / `report.json` (default true) */
	analyze?: boolean;
	/** `--yes`: consent to downloads the analysis needs */
	yes?: boolean;
	/** the caller is the collector itself: do not signal or wait for it */
	fromCollector?: boolean;
};

export type StopOutcome = {
	session: PerfSession;
	report?: PerfReportJson;
	reportPath?: string;
	warnings: string[];
};

function sessionTarget(session: PerfSession): PerfTarget {
	return {
		udid: session.device.udid,
		platform: session.device.platform,
		...(session.device.name === undefined ? {} : { name: session.device.name }),
		ownedByCaller: false,
		source: "flag",
		mode: "observe",
	};
}

async function waitCollectorExit(deps: PerfDeps, io: SessionIo, session: PerfSession): Promise<boolean> {
	const pid = signalCollector(deps.session, session);
	if (pid === undefined) return true;
	let waited = 0;
	while (deps.session.pidAlive(pid) && waited < COLLECTOR_EXIT_WAIT_MS) {
		await io.sleep(POLL_MS);
		waited += POLL_MS;
	}
	return !deps.session.pidAlive(pid);
}

function crashLine(c: CrashOut): string {
	return `${c.kind.toUpperCase()} ${c.process}: ${c.summary}${c.firstAppFrame === undefined ? "" : ` at ${c.firstAppFrame}`}`;
}

/** Stop the session's native recorder when one is still running; failures become warnings. */
async function stopNativeStep(
	ctx: CommandContext,
	deps: PerfDeps,
	kit: SessionKit,
	id: string,
	target: PerfTarget,
	opts: StopOptions,
	warnings: string[]
): Promise<void> {
	const recorded = readHandleFile(sessionNativeDir(ctx, id));
	if (recorded?.status !== "running") return;
	const stopped = await stopNative(ctx, deps, kit.io, kit.profilers, target, {
		analyze: opts.analyze !== false,
		sessionId: id,
		...(opts.yes === true ? { yes: true } : {}),
	});
	if (!stopped.success) {
		warnings.push(`native: ${stopped.error.message}`);
		return;
	}
	warnings.push(...stopped.data.warnings);
	if (stopped.data.analysis !== undefined)
		writeNativeSummary(ctx, id, nativeSummaryOf(target.platform, stopped.data.analysis, recorded.handle.startWallMs));
}

/** Read the session's crashes, copy the raw reports into it and write the crash summary; failures become warnings. */
async function crashStep(
	ctx: CommandContext,
	target: PerfTarget,
	appId: string,
	first: PerfSession,
	warnings: string[]
): Promise<void> {
	const id = first.id;
	try {
		const read = await readCrashes(ctx, target, appId, {
			sinceMs: Math.max(1, ctx.now() - first.startedAt.wallMs),
			crashDir: join(sessionDir(ctx, id), "crashes"),
			timeoutMs: 20_000,
		});
		mkdirSync(join(sessionDir(ctx, id), "crashes"), { recursive: true });
		writeFileAtomic(
			join(sessionDir(ctx, id), CRASH_SUMMARY),
			`${JSON.stringify({ count: read.crashes.length, lines: read.crashes.map(crashLine), findings: crashFindings(read.crashes), notes: read.notes }, null, 2)}\n`
		);
	} catch (error) {
		warnings.push(`crashes: ${errorMessage(error)}`);
	}
}

/**
 * The stop path shared by `perf stop`, the collector's auto-stop and the release hook. Idempotent: every step checks
 * whether it already ran. Order, reverse of start: signal the collector (it aborts the captures it hosts and flushes
 * their files) and wait for it, stop the native recorder, read the frames, collect crashes, mark the session stopped,
 * give back a lease `start` took, then build `report.md` + `report.json`.
 */
export async function finalizeSession(
	ctx: CommandContext,
	deps: PerfDeps,
	kit: SessionKit,
	id: string,
	opts: StopOptions
): Promise<Result<StopOutcome, UiError>> {
	const first = readSession(ctx, id);
	if (first === undefined)
		return { success: false, error: uiError("session_not_found", `no perf session ${id}`, { hint: "warden perf ls" }) };
	const plan = readPlan(ctx, id);
	const warnings: string[] = [];
	const target = sessionTarget(first);
	const appId = first.app?.id ?? plan?.app;

	if (opts.fromCollector !== true && first.status === "running" && !(await waitCollectorExit(deps, kit.io, first)))
		warnings.push("the collector did not exit in time: some captures may be incomplete");

	await stopNativeStep(ctx, deps, kit, id, target, opts, warnings);

	if (plan?.frames === true && appId !== undefined && target.platform === "android") {
		const frames = await captureSessionFrames(ctx, target.udid, appId, first);
		if (!frames.success) warnings.push(`frames: ${frames.error.message}`);
	}

	if (appId !== undefined && opts.analyze !== false) await crashStep(ctx, target, appId, first, warnings);

	const stopped =
		first.status === "running" ? stopSession(ctx, deps.session, id, opts.reason, { signalCollector: false }) : first;
	await giveBackLease(ctx, id);
	const session = stopped ?? readSession(ctx, id) ?? first;
	if (opts.analyze === false) return ok({ session, warnings });
	const report = writeSessionReport(ctx, session);
	return ok({ session, report, reportPath: join(sessionDir(ctx, id), "report.md"), warnings });
}
