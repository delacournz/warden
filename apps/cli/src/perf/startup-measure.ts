import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import { parseFullyDrawn } from "@delacour/warden-perf/startup/android-am-start";
import {
	launchDurationMs,
	parseLaunchPeriods,
	pickLaunchSchema,
	xctraceLaunchArgv,
	xctraceTableArgv,
	xctraceTocArgv,
} from "@delacour/warden-perf/startup/ios-app-launch";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { appPid, iosAppBundle } from "./app-process";
import { type LaunchResult, launchApp, type RelaunchIo, resolveLauncher, terminateApp } from "./relaunch";

const HOME_SETTLE_MS = 1000;
const WARM_UP_SETTLE_MS = 1500;

export type StartupKind = "cold" | "warm";

export type StartupRun = {
	index: number;
	kind: StartupKind;
	totalMs: number;
	/** Android: the system's own wait (includes time before the activity was drawn) */
	waitMs?: number;
	/** Android `LaunchState` as the system classified the start (a "warm" run that says COLD lost its process) */
	launchState?: string;
	/** Android: the app's own `reportFullyDrawn()` after this run */
	fullyDrawnMs?: number;
};

export type MeasureIo = RelaunchIo & { sleep: (ms: number) => Promise<void> };

export type Measured = { runs: StartupRun[]; notes: string[] };

export type MeasureCtx = {
	ctx: CommandContext;
	device: { platform: Platform; id: string };
	appId: string;
	kinds: readonly StartupKind[];
	count: number;
	io: MeasureIo;
	/** session dir (or one-shot dir): xctrace traces land in `native/` */
	outDir: string;
};

type Launched = Extract<LaunchResult, { kind: "launched" }>;

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

/** A launch that did not start, as the `UiError` the command reports. */
function launchError(result: Extract<LaunchResult, { kind: "failed" }>): UiError {
	return uiError(
		result.reason === "no_launcher" ? "app_not_found" : "failed",
		result.message,
		result.hint === undefined ? {} : { hint: result.hint }
	);
}

async function launchOrFail(
	c: MeasureCtx,
	opts: { cold: boolean; component?: string }
): Promise<Result<Launched, UiError>> {
	const launched = await launchApp(c.ctx, c.device, c.appId, opts, c.io);
	return launched.kind === "failed" ? fail(launchError(launched)) : ok(launched);
}

/** Warm runs need a live process: start the app (untimed) when it is not running. */
async function ensureRunning(c: MeasureCtx, component?: string): Promise<Result<undefined, UiError>> {
	if ((await appPid(c.ctx, c.device, c.appId)) !== undefined) return ok(undefined);
	const up = await launchOrFail(c, { cold: false, ...(component !== undefined ? { component } : {}) });
	if (!up.success) return up;
	await c.io.sleep(WARM_UP_SETTLE_MS);
	return ok(undefined);
}

type AndroidState = { adb: string; component: string; drawnSeen: number };

/** The newest `Fully drawn` line for this app since the previous run. */
async function newFullyDrawn(c: MeasureCtx, s: AndroidState): Promise<number | undefined> {
	const log = await c.ctx.exec([s.adb, "-s", c.device.id, "logcat", "-d", "-s", "ActivityTaskManager"], {
		timeoutMs: 15_000,
	});
	const drawn = parseFullyDrawn(log.stdout).filter((d) => d.component.startsWith(`${c.appId}/`));
	const fresh = drawn.slice(s.drawnSeen).at(-1);
	s.drawnSeen = drawn.length;
	return fresh?.ms;
}

function androidNote(kind: StartupKind, index: number, state: string | undefined): string | undefined {
	if (kind === "cold" && state !== undefined && state !== "COLD")
		return `cold run ${index} reported LaunchState ${state}`;
	if (kind === "warm" && state === "COLD") return `warm run ${index} was a cold start (process died)`;
	return undefined;
}

async function androidRun(
	c: MeasureCtx,
	s: AndroidState,
	kind: StartupKind,
	index: number
): Promise<Result<{ run: StartupRun; note?: string }, UiError>> {
	if (kind === "warm") {
		await c.ctx.exec([s.adb, "-s", c.device.id, "shell", "input", "keyevent", "KEYCODE_HOME"], { timeoutMs: 10_000 });
		await c.io.sleep(HOME_SETTLE_MS);
	}
	const launched = await launchOrFail(c, { cold: kind === "cold", component: s.component });
	if (!launched.success) return launched;
	const { am, wallMs } = launched.data;
	const fullyDrawnMs = await newFullyDrawn(c, s);
	const note = androidNote(kind, index, am?.launchState);
	return ok({
		run: {
			index,
			kind,
			totalMs: am?.totalMs ?? wallMs,
			...(am?.waitMs !== undefined ? { waitMs: am.waitMs } : {}),
			...(am?.launchState !== undefined ? { launchState: am.launchState } : {}),
			...(fullyDrawnMs !== undefined ? { fullyDrawnMs } : {}),
		},
		...(note !== undefined ? { note } : {}),
	});
}

/** Android: `am start -W` per run; cold adds `-S`, warm sends HOME first. TotalTime is the time to the first frame. */
export async function measureAndroid(c: MeasureCtx): Promise<Result<Measured, UiError>> {
	const component = await resolveLauncher(c.ctx, c.device, c.appId);
	if (!component.success) return component;
	const adb = androidTools(c.ctx.env).adb;
	await c.ctx.exec([adb, "-s", c.device.id, "logcat", "-c"], { timeoutMs: 10_000 });
	const state: AndroidState = { adb, component: component.data, drawnSeen: 0 };
	const out: Measured = { runs: [], notes: [] };
	for (const kind of c.kinds) {
		if (kind === "warm") {
			const up = await ensureRunning(c, state.component);
			if (!up.success) return up;
		}
		for (let i = 1; i <= c.count; i++) {
			const one = await androidRun(c, state, kind, i);
			if (!one.success) return one;
			out.runs.push(one.data.run);
			if (one.data.note !== undefined) out.notes.push(one.data.note);
		}
	}
	return ok(out);
}

/** iOS `approx`: wall time of `simctl launch` (cold adds `--terminate-running-process`): time to process spawn, a lower bound. */
export async function measureIosApprox(c: MeasureCtx): Promise<Result<Measured, UiError>> {
	const out: Measured = {
		runs: [],
		notes: [
			"method simctl-approx: wall time of simctl launch, a lower bound on time to first frame; use --method xctrace",
		],
	};
	for (const kind of c.kinds) {
		if (kind === "warm") {
			const up = await ensureRunning(c);
			if (!up.success) return up;
		}
		for (let index = 1; index <= c.count; index++) {
			if (kind === "warm") {
				await c.ctx.exec(["xcrun", "simctl", "launch", c.device.id, "com.apple.springboard"], { timeoutMs: 15_000 });
				await c.io.sleep(HOME_SETTLE_MS);
			}
			const launched = await launchOrFail(c, { cold: kind === "cold" });
			if (!launched.success) return launched;
			out.runs.push({ index, kind, totalMs: launched.data.wallMs });
		}
	}
	return ok(out);
}

const XCTRACE_HINT = "xctrace App Launch on a simulator is a spike; --method approx times simctl launch instead";

/** SPIKE: one xctrace App Launch recording of the installed `.app`, exported to its launch time. */
async function xctraceRun(c: MeasureCtx, appPath: string, trace: string): Promise<Result<number, UiError>> {
	const { ctx, device } = c;
	const rec = await ctx.exec(xctraceLaunchArgv(device.id, appPath, trace), { timeoutMs: 120_000 });
	if (rec.exitCode !== 0) {
		const why = (rec.stderr || rec.stdout).trim().split("\n").pop();
		return fail(uiError("failed", `xctrace record failed: ${why}`, { hint: XCTRACE_HINT }));
	}
	const toc = await ctx.exec(xctraceTocArgv(trace), { timeoutMs: 60_000 });
	const schema = toc.exitCode === 0 ? pickLaunchSchema(toc.stdout) : undefined;
	if (schema === undefined) {
		return fail(
			uiError("failed", "the trace has no launch table (life-cycle-period / app-launch)", { hint: XCTRACE_HINT })
		);
	}
	const table = await ctx.exec(xctraceTableArgv(trace, schema), { timeoutMs: 60_000 });
	const periods = parseLaunchPeriods(table.stdout);
	if (!periods.success) return fail(uiError("failed", periods.error, { hint: XCTRACE_HINT }));
	const total = launchDurationMs(periods.data);
	return total === undefined
		? fail(uiError("failed", "no launch period in the trace", { hint: XCTRACE_HINT }))
		: ok(total);
}

/** SPIKE: iOS `xctrace record --template 'App Launch' --launch`, cold only; traces are kept under `native/`. */
export async function measureIosXctrace(c: MeasureCtx): Promise<Result<Measured, UiError>> {
	if (c.kinds.includes("warm")) return fail(uiError("usage", "--method xctrace measures cold launches only"));
	const bundle = await iosAppBundle(c.ctx, c.device.id, c.appId);
	if (!bundle.success) return bundle;
	const dir = join(c.outDir, "native");
	mkdirSync(dir, { recursive: true });
	const runs: StartupRun[] = [];
	for (let index = 1; index <= c.count; index++) {
		const stopped = await terminateApp(c.ctx, c.device, c.appId);
		if (!stopped.success) return stopped;
		const total = await xctraceRun(c, bundle.data.appPath, join(dir, `startup-${index}.trace`));
		if (!total.success) return total;
		runs.push({ index, kind: "cold", totalMs: total.data });
	}
	return ok({
		runs,
		notes: [
			"method xctrace is a spike: the launch table is parsed per the export format, unconfirmed on simulator traces",
		],
	});
}
