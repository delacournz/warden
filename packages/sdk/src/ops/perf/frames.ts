import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Anchor, analyzeFrames, type FramesReport, jankFinding } from "@delacour/warden-perf/frames/analyze";
import { type GfxInfo, parseGfxinfo } from "@delacour/warden-perf/frames/gfxinfo";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { androidTools } from "@delacour/warden-providers/android-tools";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opError } from "../errors";
import { writeFileAtomic } from "./device-state";
import type { PerfEnv, PerfUiEnv } from "./env";
import { activeSessionFor, sessionDir } from "./session";
import type { PerfDone, PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

/** Written to the active session's directory beside `session.json`. */
export const FRAMES_FILE = "frames.json";

const IOS_UNSUPPORTED_HINT =
	"the iOS simulator has no frame API; hitches and hangs come from the native trace: warden perf start --native";

const adb = (ctx: PerfEnv, serial: string, ...args: string[]): string[] => [
	androidTools(ctx.env).adb,
	"-s",
	serial,
	"shell",
	...args,
];

/** `dumpsys gfxinfo <pkg> framestats`, parsed; undefined when the call fails or the app has no render stats. */
async function readGfxinfo(ctx: PerfEnv, serial: string, pkg: string): Promise<GfxInfo | undefined> {
	const res = await ctx.exec(adb(ctx, serial, "dumpsys", "gfxinfo", pkg, "framestats"), { timeoutMs: 15_000 });
	return res.exitCode === 0 ? parseGfxinfo(res.stdout) : undefined;
}

/**
 * Live frame rate for `perf metrics --watch`: one gfxinfo read (no reset), fps and missed-deadline % over the OS's
 * latest ~120 frames. Undefined when the app is not rendering or nothing was sampled.
 */
export async function androidFrameRate(
	ctx: PerfEnv,
	serial: string,
	pkg: string
): Promise<{ fps: number; jankPct: number } | undefined> {
	const info = await readGfxinfo(ctx, serial, pkg);
	if (info === undefined || info.frames.length === 0) return undefined;
	const report = analyzeFrames(info);
	return { fps: report.fps, jankPct: report.sampleJankPct };
}

export type FramesResult =
	| ({ status: "ok"; app: string; session?: string; reset: boolean; findings: Finding[] } & FramesReport)
	| { status: "unsupported"; platform: "ios"; app: string; reason: string; hint: string };

/**
 * Read the app's frame stats for a session being stopped and write `<session>/frames.json` (what `perf stop` collects;
 * the session may already be past its cap, so it is passed in rather than looked up).
 */
export async function captureSessionFrames(
	ctx: PerfEnv,
	udid: string,
	app: string,
	session: PerfSession
): Promise<Result<Extract<FramesResult, { status: "ok" }>, WardenError>> {
	const gfx = await readGfxinfo(ctx, udid, app);
	if (gfx === undefined) return noStats(app);
	const report = analyzeFrames(gfx, {
		readAtSessionMs: ctx.now() - session.startedAt.wallMs,
		marks: session.marks,
	});
	const finding = jankFinding(report);
	const result: Extract<FramesResult, { status: "ok" }> = {
		status: "ok",
		app,
		session: session.id,
		reset: false,
		findings: finding ? [finding] : [],
		...report,
	};
	const dir = sessionDir(ctx, session.id);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(join(dir, FRAMES_FILE), `${JSON.stringify(result, null, 2)}\n`);
	return resultFactory.ok(result);
}

/** Clear the OS frame counters so the next read covers a fresh window (a mutation: the caller holds the lease). */
export async function resetFrameCounters(ctx: PerfEnv, udid: string, app: string): Promise<boolean> {
	const res = await ctx.exec(adb(ctx, udid, "dumpsys", "gfxinfo", app, "reset"), { timeoutMs: 10_000 });
	return res.exitCode === 0;
}

function anchorFor(ctx: PerfEnv, deps: PerfEngineDeps, udid: string): { anchor?: Anchor; sessionId?: string } {
	const session = activeSessionFor(ctx, deps.session, udid);
	if (session === undefined) return {};
	return {
		sessionId: session.id,
		anchor: { readAtSessionMs: ctx.now() - session.startedAt.wallMs, marks: session.marks },
	};
}

function render(ctx: PerfUiEnv, r: Extract<FramesResult, { status: "ok" }>): string {
	const { color } = ctx.ui;
	const lines = [
		`${color.green("frames")} ${r.app}: ${r.fps} fps @ ${r.refreshHz}Hz, ${r.jankPct}% janky (${r.jankyFrames}/${r.totalFrames}), ${r.droppedFrames} dropped, ${r.frozenFrames} frozen, worst ${r.worstFrameMs}ms`,
	];
	for (const w of r.worstWindows) {
		const span = `+${(w.startOffsetMs / 1000).toFixed(1)}s..+${(w.endOffsetMs / 1000).toFixed(1)}s`;
		lines.push(
			`  ${span}  ${w.missedDeadlineFrameCount} frames over ${r.deadlineMs}ms, worst ${w.worstFrameMs}ms${w.mark ? `  after "${w.mark}"` : ""}`
		);
	}
	if (r.sampledFrames === 0) lines.push(color.dim("  no frames in the buffer: interact with the app, then read again"));
	if (r.reset) lines.push(color.dim("  counters reset: the next read covers a fresh window"));
	return lines.join("\n");
}

type FramesWork = Result<PerfDone<FramesResult>, WardenError>;

function iosUnsupported(ctx: PerfUiEnv, target: PerfTarget, app: string): FramesWork {
	const result: FramesResult = {
		status: "unsupported",
		platform: "ios",
		app,
		reason: "the iOS simulator exposes no frame timing API",
		hint: IOS_UNSUPPORTED_HINT,
	};
	return resultFactory.ok({
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result,
		text: `${ctx.ui.color.yellow("unsupported")} frames on the iOS simulator\n${ctx.ui.color.dim(IOS_UNSUPPORTED_HINT)}`,
		warnings: [IOS_UNSUPPORTED_HINT],
	});
}

async function androidFrames(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	target: PerfTarget,
	app: string,
	reset: boolean
): Promise<FramesWork> {
	const gfx = await readGfxinfo(ctx, target.udid, app);
	if (gfx === undefined) return noStats(app);
	const { anchor, sessionId } = anchorFor(ctx, deps, target.udid);
	const report = analyzeFrames(gfx, anchor);
	const finding = jankFinding(report);
	const result: Extract<FramesResult, { status: "ok" }> = {
		status: "ok",
		app,
		...(sessionId !== undefined ? { session: sessionId } : {}),
		reset,
		findings: finding ? [finding] : [],
		...report,
	};
	if (sessionId !== undefined) {
		const dir = sessionDir(ctx, sessionId);
		mkdirSync(dir, { recursive: true });
		writeFileAtomic(join(dir, FRAMES_FILE), `${JSON.stringify(result, null, 2)}\n`);
	}
	const warnings: string[] = [];
	if (reset) {
		const cleared = await ctx.exec(adb(ctx, target.udid, "dumpsys", "gfxinfo", app, "reset"), { timeoutMs: 10_000 });
		if (cleared.exitCode !== 0) warnings.push(`gfxinfo reset failed: ${cleared.stderr.trim() || cleared.exitCode}`);
	}
	return resultFactory.ok({
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result,
		text: render(ctx, result) + (finding ? `\n  ${ctx.ui.color.yellow(finding.severity)} ${finding.evidence}` : ""),
		...(warnings.length > 0 ? { warnings } : {}),
	});
}

function noStats(pkg: string): Result<never, WardenError> {
	return {
		success: false,
		error: opError("app_not_found", `no render stats for ${pkg}: the app is not running or has not drawn a frame`, {
			hint: "launch the app (and interact with it), then run warden perf frames again",
		}),
	};
}

/**
 * The frames work of a resolved device and app: Android fps / jank from `gfxinfo framestats` (optionally clearing the
 * counters, a mutation), iOS reports `unsupported`. With an active session the windows are offsets from its start and
 * the report is written to the session's `frames.json`.
 */
export async function framesWork(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	target: PerfTarget,
	app: string,
	reset: boolean
): PerfOutcome<FramesResult> {
	return target.platform === "ios" ? iosUnsupported(ctx, target, app) : androidFrames(ctx, deps, target, app, reset);
}
