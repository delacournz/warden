import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { type CpuProfile, cpuProfileSchema } from "@delacour/warden-perf/js/cpu-profile";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import {
	commitsByComponent,
	commitsByIndex,
	commitsByWindow,
	commitsCascade,
	cpuTree,
	cpuWindow,
	jsCallers,
	type NamedFrame,
} from "@delacour/warden-perf/shared/query";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { ok, type Result } from "@delacour/warden-types/result";
import { reportError, reportOk, type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { defaultNativeProfilers, type NativeProfilers } from "./native";
import { sessionNativeDir } from "./native-state";
import { withPerfOptions } from "./options";
import { sessionDir } from "./paths";
import { loadCpuCorrelation } from "./react-capture";
import { readCommitsFile } from "./report-read";
import type { PerfDeps, PerfOptionValues } from "./run";
import { pickSession } from "./session-pick";

export type PerfQueryOptions = PerfOptionValues & {
	by?: string;
	top?: boolean;
	tree?: boolean;
	worst?: boolean;
	window?: string;
	size?: string;
	index?: string;
	limit?: string;
	rerun?: boolean;
	yes?: boolean;
};

type Answer = { result: unknown; lines: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

const missing = (what: string, hint: string): { success: false; error: UiError } => ({
	success: false,
	error: uiError("failed", `this session has no ${what}`, { hint }),
});

/** A window may start at the session start; `parseDuration` itself rejects 0. */
const ZERO = /^0+(?:\.0+)?(?:ms|s|m)?$/;

/** `2s-5s` / `2-5` / `500ms-1.5s` / `0-5s` as session-timeline ms. */
export function parseWindow(raw: string): { fromMs: number; toMs: number } | undefined {
	const parts = raw.split("-");
	if (parts.length !== 2) return undefined;
	const [a, b] = parts.map((p) => (ZERO.test(p.trim()) ? 0 : parseDuration(p)));
	return a === undefined || b === undefined || b <= a ? undefined : { fromMs: a, toMs: b };
}

function readProfile(dir: string): CpuProfile | undefined {
	const parsed = cpuProfileSchema.safeParse(readJson(join(dir, "js", "cpu.cpuprofile")));
	return parsed.success ? parsed.data : undefined;
}

const anonymous: NamedFrame = (f) => ({ name: f.functionName === "" ? "(anonymous)" : f.functionName });

function nativeReportOf(dir: string): { platform: "ios" | "android"; report: unknown } | undefined {
	for (const [platform, file] of [
		["ios", "ios-native.json"],
		["android", "android-native.json"],
	] as const) {
		const path = join(dir, "native", file);
		if (existsSync(path)) return { platform, report: readJson(path) };
	}
	return undefined;
}

/** The hangs of a native analysis JSON as lines: iOS with top functions and call chains, Android with the main-thread state split. */
export function hangLines(platform: "ios" | "android", report: unknown): string[] {
	if (!isRecord(report)) return [];
	const lines: string[] = [];
	if (platform === "ios") {
		for (const h of arr(report.hangs)) {
			if (!isRecord(h)) continue;
			lines.push(
				`${Math.round(num(h.durationMs) ?? 0)}ms @ ${sec(num(h.atMs) ?? 0)} (trace time) ${str(h.kind) ?? ""}`.trimEnd()
			);
			for (const f of arr(h.topFunctions).slice(0, 5)) {
				if (isRecord(f)) lines.push(`  fn ${str(f.name) ?? "?"}  ${num(f.samples) ?? 0} samples`);
			}
			for (const c of arr(h.chains).slice(0, 3)) {
				if (isRecord(c)) lines.push(`  chain ${str(c.chain) ?? "?"}  ${num(c.samples) ?? 0}`);
			}
		}
		return lines;
	}
	const root = report.hangs;
	for (const h of isRecord(root) ? arr(root.hangs) : []) {
		if (!isRecord(h)) continue;
		const main = isRecord(h.main) ? h.main : {};
		const split = Object.entries(main)
			.filter(([, v]) => typeof v === "number" && v > 0)
			.map(([k, v]) => `${k} ${Math.round(Number(v))}ms`)
			.join(", ");
		lines.push(
			`${Math.round(num(h.durMs) ?? 0)}ms @ ${sec(num(h.atMs) ?? 0)} ${str(h.jankType) ?? ""}  main: ${split || "n/a"}`
		);
	}
	return lines;
}

function commitsAnswer(dir: string, opts: PerfQueryOptions, rest: readonly string[]): Result<Answer, UiError> {
	const file = readCommitsFile(dir);
	if (file === undefined) return missing("React profile", "record with --react: warden perf record --react");
	const limit = opts.limit === undefined ? undefined : Number(opts.limit);
	const by = opts.by ?? "component";
	if (by === "component") {
		const rows = commitsByComponent(file.commits, limit);
		return ok({
			result: { by, rows },
			lines: rows.map(
				(r) =>
					`${r.name}  renders ${r.renders} (mounts ${r.mounts})  self ${r.sumSelfMs}ms  max ${r.maxSelfMs}ms  in ${r.commits} commits${r.memo ? "  memo" : ""}`
			),
		});
	}
	if (by === "window") {
		const size = opts.size === undefined ? 1000 : parseDuration(opts.size);
		if (size === undefined)
			return { success: false, error: uiError("usage", `--size must be a duration, got "${opts.size}"`) };
		const rows = commitsByWindow(file.commits, size, limit);
		return ok({
			result: { by, windowMs: size, rows },
			lines: rows.map(
				(r) =>
					`${sec(r.fromMs)}-${sec(r.toMs)}  ${r.commits} commits  ${r.renderMs}ms  worst ${r.worstMs}ms  ${r.top.join(", ")}`
			),
		});
	}
	if (by === "index") {
		const raw = opts.index ?? rest[0];
		const only = raw === undefined ? undefined : Number(raw);
		if (only !== undefined && !Number.isInteger(only))
			return { success: false, error: uiError("usage", `commit index must be an integer, got "${raw}"`) };
		const rows = commitsByIndex(file.commits, {
			...(only === undefined ? {} : { only }),
			...(limit === undefined ? {} : { limit }),
		});
		if (rows.length === 0) return { success: false, error: uiError("failed", `no commit #${only} in this session`) };
		return ok({
			result: { by, rows },
			lines: rows.flatMap((r) => [
				`#${r.index} @${sec(r.startMs)}  ${r.durationMs}ms  ${r.fibers} fibers${r.updaters.length > 0 ? `  updated by ${r.updaters.join(", ")}` : ""}`,
				...r.top.map((t) => `  ${t.name}  ${t.selfMs}ms  (${t.cause})`),
			]),
		});
	}
	if (by === "cascade") {
		const rows = commitsCascade(file.commits, limit);
		return ok({
			result: { by, rows },
			lines: rows.map(
				(r) =>
					`${r.origin}  ${r.commits} commits  ${r.cascadeFibers}/${r.fibers} fibers re-rendered by a parent or context  ${r.renderMs}ms`
			),
		});
	}
	return { success: false, error: uiError("usage", `--by must be component, window, index or cascade, got "${by}"`) };
}

function cpuAnswer(dir: string, session: PerfSession, opts: PerfQueryOptions): Result<Answer, UiError> {
	const hotspots = readJson(join(dir, "js", "hotspots.json"));
	const profile = readProfile(dir);
	const limit = opts.limit === undefined ? 15 : Number(opts.limit);
	const native = nativeReportOf(dir);
	if (profile === undefined && native === undefined)
		return missing("CPU profile", "record with --js or --native: warden perf record --js");
	const label: NamedFrame = loadCpuCorrelation(join(dir, "js"))?.label ?? anonymous;
	if (opts.tree === true || opts.window !== undefined) {
		if (profile === undefined) return missing("JS CPU profile", "record with --js: warden perf record --js");
		if (opts.tree === true) {
			const rows = cpuTree(profile, label);
			return ok({
				result: { mode: "tree", rows },
				lines: rows.map(
					(r) => `${"  ".repeat(r.depth - 1)}${r.name}  ${r.totalPct}% (${r.totalMs}ms, self ${r.selfMs}ms)`
				),
			});
		}
		const window = parseWindow(opts.window ?? "");
		if (window === undefined)
			return { success: false, error: uiError("usage", `--window must look like 2s-5s, got "${opts.window}"`) };
		const anchor = isRecord(hotspots) && isRecord(hotspots.anchor) ? num(hotspots.anchor.hostWallMs) : undefined;
		if (anchor === undefined) return missing("clock anchor for the JS profile", "re-record with --js");
		const rows = cpuWindow(profile, label, { ...window, profileStartMs: anchor - session.startedAt.wallMs }, limit);
		return ok({
			result: { mode: "window", window, rows },
			lines: [
				`JS self time ${sec(window.fromMs)}-${sec(window.toMs)}`,
				...rows.map((r) => `${r.name}  ${r.selfMs}ms  ${r.selfPct}%`),
			],
		});
	}
	const lines: string[] = [];
	const result: Record<string, unknown> = { mode: "top" };
	if (isRecord(hotspots) && Array.isArray(hotspots.topSelf)) {
		const top = (hotspots as unknown as Hotspots).topSelf.slice(0, limit);
		result.js = top;
		lines.push(
			"JS self time:",
			...top.map((f) => `  ${f.name}  ${f.selfPct}%  ${f.mapped ? `${f.file}:${f.line}` : f.file}`)
		);
	}
	if (native !== undefined && isRecord(native.report)) {
		const rows: Array<{ name: string; selfPct: number }> = [];
		if (native.platform === "ios") {
			for (const h of arr(native.report.hotspots)) {
				if (isRecord(h))
					rows.push({ name: `${str(h.frame) ?? "?"} (${str(h.thread) ?? ""})`, selfPct: num(h.selfPct) ?? 0 });
			}
		} else if (isRecord(native.report.cpu)) {
			for (const f of arr(native.report.cpu.functions)) {
				if (isRecord(f))
					rows.push({ name: `${str(f.function) ?? "?"} (${str(f.thread) ?? ""})`, selfPct: num(f.selfPct) ?? 0 });
			}
		} else {
			for (const r of arr(native.report.top)) {
				if (isRecord(r)) rows.push({ name: str(r.symbol) ?? "?", selfPct: num(r.percent) ?? 0 });
			}
		}
		const top = rows.slice(0, limit);
		result.native = top;
		lines.push("native self time:", ...top.map((r) => `  ${r.name}  ${r.selfPct.toFixed(1)}%`));
	}
	return ok({ result, lines });
}

async function stacksAnswer(
	ctx: CommandContext,
	deps: PerfDeps,
	dir: string,
	session: PerfSession,
	opts: PerfQueryOptions,
	rest: readonly string[],
	profilers: NativeProfilers
): Promise<Result<Answer, UiError>> {
	const sub = rest[0] ?? "hang";
	const native = nativeReportOf(dir);
	if (sub === "hang") {
		if (native === undefined) return missing("native profile", "record with --native: warden perf record --native");
		let report = native.report;
		if (opts.rerun === true) {
			if (native.platform !== "android")
				return { success: false, error: uiError("usage", "--rerun re-runs the Perfetto SQL: Android sessions only") };
			const window = opts.window === undefined ? undefined : parseWindow(opts.window);
			if (opts.window !== undefined && window === undefined)
				return { success: false, error: uiError("usage", `--window must look like 2s-5s, got "${opts.window}"`) };
			const profiler = await profilers.android();
			const trace = join(sessionNativeDir(ctx, session.id), "android.perfetto-trace");
			const analysis = await profiler.analyze(ctx, deps, {
				target: {
					udid: session.device.udid,
					platform: "android",
					ownedByCaller: false,
					source: "flag",
					mode: "observe",
				},
				app: session.app?.id ?? "",
				dir: sessionNativeDir(ctx, session.id),
				trace,
				...(window === undefined ? {} : { windowMs: { startMs: window.fromMs, endMs: window.toMs } }),
				...(opts.yes === true ? { yes: true } : {}),
			});
			if (!analysis.success) return analysis;
			report = analysis.data.report;
		}
		const lines = hangLines(native.platform, report);
		return ok({
			result: { sub, platform: native.platform, report: isRecord(report) ? report.hangs : null },
			lines: lines.length > 0 ? lines : ["no hangs"],
		});
	}
	if (sub === "callers") {
		const fn = rest[1];
		if (fn === undefined) return { success: false, error: uiError("usage", "stacks callers needs a function name") };
		const profile = readProfile(dir);
		const lines: string[] = [];
		const result: Record<string, unknown> = { sub, fn };
		if (profile !== undefined) {
			const rows = jsCallers(profile, loadCpuCorrelation(join(dir, "js"))?.label ?? anonymous, fn);
			result.js = rows;
			lines.push(
				`JS callers of ${fn}:`,
				...(rows.length === 0 ? ["  none"] : rows.map((r) => `  ${r.caller}  ${r.ms}ms  ${r.pct}%`))
			);
		}
		if (native?.platform === "ios" && isRecord(native.report)) {
			const chains = arr(native.report.hangs)
				.flatMap((h) => (isRecord(h) ? arr(h.chains) : []))
				.flatMap((c) =>
					isRecord(c) && str(c.chain)?.toLowerCase().includes(fn.toLowerCase())
						? [`${str(c.chain)}  ${num(c.samples) ?? 0}`]
						: []
				);
			result.native = chains;
			if (chains.length > 0) lines.push(`native chains through ${fn}:`, ...chains.map((c) => `  ${c}`));
		}
		if (profile === undefined && native === undefined) return missing("CPU profile", "record with --js or --native");
		return ok({ result, lines });
	}
	if (sub === "thread") {
		if (native === undefined || !isRecord(native.report)) return missing("native profile", "record with --native");
		const rows = arr(native.report.threads);
		const lines = rows.flatMap((t) => {
			if (!isRecord(t)) return [];
			const name = str(t.thread) ?? "?";
			if (num(t.pct) !== undefined) return [`${name}  ${num(t.pct)}%`];
			return [
				`${name}  running ${Math.round(num(t.runningMs) ?? 0)}ms  runnable ${Math.round(num(t.runnableMs) ?? 0)}ms  io ${Math.round(num(t.ioMs) ?? 0)}ms  sleeping ${Math.round(num(t.sleepingMs) ?? 0)}ms`,
			];
		});
		return ok({ result: { sub, threads: rows }, lines: lines.length > 0 ? lines : ["no thread data"] });
	}
	if (sub === "leaks") {
		if (native === undefined || !isRecord(native.report))
			return missing("native profile", "record with --native --leaks (iOS)");
		const leaks = arr(native.report.leaks);
		const lines = leaks.flatMap((l) =>
			isRecord(l)
				? [`${str(l.type) ?? "?"}  ${num(l.count) ?? 0}x  ${num(l.bytes) ?? 0} bytes  at ${str(l.frame) ?? "?"}`]
				: []
		);
		return ok({ result: { sub, leaks }, lines: lines.length > 0 ? lines : ["no leaks recorded"] });
	}
	return { success: false, error: uiError("usage", `stacks <hang|callers <fn>|thread|leaks>, got "${sub}"`) };
}

function framesAnswer(dir: string, opts: PerfQueryOptions): Result<Answer, UiError> {
	const frames = readJson(join(dir, "frames.json"));
	const native = nativeReportOf(dir);
	if (!isRecord(frames) && native === undefined)
		return missing("frame data", "record with --frames (Android) or --native: warden perf record --frames");
	const lines: string[] = [];
	const result: Record<string, unknown> = {};
	if (isRecord(frames) && frames.status === "ok") {
		const windows = arr(frames.worstWindows);
		result.windows = windows;
		lines.push(
			`${num(frames.fps) ?? 0} fps, ${num(frames.jankPct) ?? 0}% janky, ${num(frames.frozenFrames) ?? 0} frozen`
		);
		for (const w of windows) {
			if (!isRecord(w)) continue;
			lines.push(
				`  ${sec(num(w.startOffsetMs) ?? 0)}..${sec(num(w.endOffsetMs) ?? 0)}  ${num(w.missedDeadlineFrameCount) ?? 0} frames over budget, worst ${num(w.worstFrameMs) ?? 0}ms${str(w.mark) === undefined ? "" : `  after "${str(w.mark)}"`}`
			);
		}
	}
	if (native !== undefined) {
		const hangs = hangLines(native.platform, native.report).filter((l) => !l.startsWith(" "));
		result.hangs = hangs;
		if (hangs.length > 0) lines.push("hangs:", ...hangs.slice(0, opts.worst === true ? 5 : 10).map((l) => `  ${l}`));
	}
	return ok({ result, lines: lines.length > 0 ? lines : ["no frame data"] });
}

/**
 * `warden perf query <id> <commits|cpu|stacks|frames> …`: drill into a session's files. `commits --by
 * component|window|index|cascade`, `cpu --top|--window a-b|--tree`, `stacks hang|callers <fn>|thread|leaks`,
 * `frames --worst`. Reads the session's artifacts (Android hang stacks re-run the Perfetto SQL with `--rerun`). No device.
 */
export async function perfQuery(
	ctx: CommandContext,
	deps: PerfDeps,
	id: string,
	topic: string,
	rest: readonly string[],
	opts: PerfQueryOptions,
	profilers: NativeProfilers = defaultNativeProfilers
): Promise<number> {
	const meta = { command: "perf query", label: "perf query", json: opts.json === true, startedAt: ctx.now() };
	try {
		const picked = await pickSession(ctx, deps, opts, id);
		if (!picked.success) return reportError(ctx, meta, picked.error);
		const session = picked.data;
		const dir = sessionDir(ctx, session.id);
		let answer: Result<Answer, UiError>;
		if (topic === "commits") answer = commitsAnswer(dir, opts, rest);
		else if (topic === "cpu") answer = cpuAnswer(dir, session, opts);
		else if (topic === "stacks") answer = await stacksAnswer(ctx, deps, dir, session, opts, rest, profilers);
		else if (topic === "frames") answer = framesAnswer(dir, opts);
		else
			answer = {
				success: false,
				error: uiError("usage", `unknown query "${topic}"`, { hint: "commits | cpu | stacks | frames" }),
			};
		if (!answer.success) return reportError(ctx, meta, answer.error);
		return reportOk(ctx, meta, {
			device: { udid: session.device.udid, platform: session.device.platform, name: session.device.name },
			result: {
				sessionId: session.id,
				topic,
				...(isRecord(answer.data.result) ? answer.data.result : { result: answer.data.result }),
			},
			text: answer.data.lines.join("\n"),
		});
	} catch (error) {
		return reportError(ctx, meta, uiError("failed", errorMessage(error)));
	}
}

/** Wire `query` onto `warden perf`. */
export function registerQuery(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("query")
			.description("drill into a session: commits, cpu, stacks, frames")
			.argument("<id>", "session id, unique prefix, or latest")
			.argument("<topic>", "commits | cpu | stacks | frames")
			.argument("[args...]", "stacks: hang | callers <fn> | thread | leaks; commits --by index: <n>")
			.option("--by <how>", "commits: component | window | index | cascade")
			.option("--top", "cpu: the hottest functions (default)")
			.option("--window <a-b>", "cpu: self time between a and b on the session timeline (e.g. 2s-5s)")
			.option("--tree", "cpu: the call tree")
			.option("--worst", "frames: the worst jank windows and hangs")
			.option("--size <time>", "commits --by window: bucket size (default 1s)")
			.option("--index <n>", "commits --by index: one commit in depth")
			.option("--limit <n>", "rows to show (commits, cpu)")
			.option("--rerun", "stacks hang: re-run the Perfetto SQL (Android)")
			.option("--yes", "download trace_processor without asking (with --rerun)")
	).action(async (id, topic, args, opts) => {
		done(await perfQuery(ctx, deps, id, topic, args, opts));
	});
}
