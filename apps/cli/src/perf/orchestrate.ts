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
	let requestedMs: number | undefined;
	if (opts.maxDuration !== undefined) {
		requestedMs = parseDuration(opts.maxDuration);
		if (requestedMs === undefined) {
			return {
				success: false,
				error: uiError("usage", `--max-duration must be a duration like 30s or 2m, got "${opts.maxDuration}"`),
			};
		}
	}
	const cap = clampMaxDuration(requestedMs);
	const warnings: string[] = cap.warning === undefined ? [] : [cap.warning];
	const caps = choice.data;
	if (caps.native !== undefined && caps.native.flavor === "simpleperf" && target.platform === "ios")
		warnings.push("--native=simpleperf is Android only: iOS records with xctrace");
	if (caps.frames && target.platform === "ios") {
		warnings.push("frames: the iOS simulator has no frame API; hangs come from --native");
		caps.frames = false;
	}

	sweepSessions(ctx, deps.session);
	const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
	if (!app.success) return app;

	const mutate = opts.relaunch === true;
	let working = target;
	let tookLease = false;
	if (mutate) {
		const resolved = await resolvePerfDevice(
			ctx,
			{ ...opts, lease: undefined, serial: undefined, udid: target.udid, claim: true },
			"mutate",
			deps.device
		);
		if (!resolved.success) {
			const e = resolved.error;
			return {
				success: false,
				error:
					e.code === "device_foreign"
						? uiError("device_foreign", e.message, {
								hint: "--relaunch / --reset restart the app, so they need a device you hold or a free one; claim another with warden claim",
							})
						: e,
			};
		}
		working = resolved.data;
		tookLease = working.lease !== undefined && !target.ownedByCaller && target.holder === undefined;
	}

	const offset = await readClockOffsetMs(ctx, { platform: target.platform, id: target.udid });
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
		app: app.data,
		maxDurationMs: cap.ms,
		...(offset === undefined ? {} : { deviceWallMs: ctx.now() + offset }),
	});
	if (!created.success) {
		if (tookLease && working.lease !== undefined) await releaseDevices(ctx, [working.lease.id], { touch: false });
		return created;
	}
	const session = created.data;
	const id = session.id;
	if (offset === undefined && target.platform === "android")
		warnings.push("could not read the device clock: JS and React times are aligned by the host clock only");

	let metroUrl: string | undefined;
	if (caps.js || caps.react) {
		metroUrl = await deps.host.metro(ctx, target.udid).catch(() => undefined);
		if (metroUrl === undefined) {
			warnings.push("js/react: no Metro found for this device (release build, or no dev client running)");
			if (caps.js) failCapturer(ctx, id, "js");
			if (caps.react) failCapturer(ctx, id, "react");
			caps.js = false;
			caps.react = false;
		}
	}
	const plan: PerfPlan = {
		version: 1,
		app: app.data.id,
		cwd: ctx.cwd,
		metrics: caps.metrics,
		frames: caps.frames,
		logs: caps.logs,
		js: caps.js,
		react: caps.react,
		...(caps.native === undefined ? {} : { native: caps.native }),
		relaunch: opts.relaunch === true,
		...(metroUrl === undefined ? {} : { metroUrl }),
		...(tookLease && working.lease !== undefined ? { leaseId: working.lease.id } : {}),
	};
	writePlan(ctx, id, plan);

	try {
		const dir = sessionDir(ctx, id);
		const { pid } = kit.io.spawnDetached({
			argv: [...kit.io.self(), "perf-collect", "--session", id],
			logPath: join(dir, "collector.log"),
		});
		updateSession(ctx, id, (s) => ({
			...s,
			capturers: [
				...s.capturers.filter((c) => c.kind !== "collector"),
				{ kind: "collector", pid, startedAtIso: iso(ctx), state: "running" },
			],
		}));

		const startNativeNow = async (): Promise<void> => {
			if (caps.native === undefined) return;
			const current = readSession(ctx, id);
			const started = await startNative(
				ctx,
				deps,
				kit.io,
				kit.profilers,
				working,
				{
					app: app.data.id,
					leaks: false,
					...(caps.native.flavor === "" ? {} : { flavor: caps.native.flavor }),
					maxDurationMs: cap.ms,
				},
				current
			);
			if (!started.success) {
				warnings.push(`native: ${started.error.message}`);
				failCapturer(ctx, id, "native");
			}
		};

		let launch: LaunchResult | undefined;
		if (opts.relaunch === true) {
			const device = { platform: target.platform, id: target.udid };
			const stopped = await terminateApp(ctx, device, app.data.id);
			if (!stopped.success) throw new StartFailure(stopped.error);
			if (opts.reset === true) {
				const wiped = await resetAppData(ctx, device, app.data.id);
				if (!wiped.success) throw new StartFailure(wiped.error);
			}
			if (target.platform === "android") {
				await startNativeNow();
				if (caps.frames) await resetFrameCounters(ctx, target.udid, app.data.id);
			}
			launch = await launchApp(ctx, device, app.data.id, { cold: true });
			if (launch.kind === "failed") {
				throw new StartFailure(
					uiError(launch.reason === "no_launcher" ? "app_not_found" : "failed", launch.message, {
						...(launch.hint === undefined ? {} : { hint: launch.hint }),
					})
				);
			}
			writeLaunchStartup(ctx, id, target, app.data.id, launch);
			if (target.platform === "ios") await startNativeNow();
		} else {
			await startNativeNow();
		}
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

	const nativeRunning = readHandleFile(sessionNativeDir(ctx, id))?.status === "running";
	if (nativeRunning) {
		const startWallMs = readHandleFile(sessionNativeDir(ctx, id))?.handle.startWallMs;
		const stopped = await stopNative(ctx, deps, kit.io, kit.profilers, target, {
			analyze: opts.analyze !== false,
			sessionId: id,
			...(opts.yes === true ? { yes: true } : {}),
		});
		if (!stopped.success) {
			warnings.push(`native: ${stopped.error.message}`);
		} else {
			warnings.push(...stopped.data.warnings);
			if (stopped.data.analysis !== undefined)
				writeNativeSummary(ctx, id, nativeSummaryOf(target.platform, stopped.data.analysis, startWallMs));
		}
	}

	if (plan?.frames === true && appId !== undefined && target.platform === "android") {
		const frames = await captureSessionFrames(ctx, target.udid, appId, first);
		if (!frames.success) warnings.push(`frames: ${frames.error.message}`);
	}

	if (appId !== undefined && opts.analyze !== false) {
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

	const stopped =
		first.status === "running" ? stopSession(ctx, deps.session, id, opts.reason, { signalCollector: false }) : first;
	await giveBackLease(ctx, id);
	const session = stopped ?? readSession(ctx, id) ?? first;
	if (opts.analyze === false) return ok({ session, warnings });
	const report = writeSessionReport(ctx, session);
	return ok({ session, report, reportPath: join(sessionDir(ctx, id), "report.md"), warnings });
}
