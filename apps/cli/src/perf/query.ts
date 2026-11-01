import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { type CpuProfile, cpuProfileSchema } from "@delacour/warden-perf/js/cpu-profile";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import { perfDuration } from "@delacour/warden-perf/metrics/duration";
import { type NamedFrame, sessionQuery } from "@delacour/warden-perf/shared/query";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { defaultNativeProfilers, type NativeProfilers } from "@delacour/warden-sdk/ops/perf/native";
import { nativeStateFiles } from "@delacour/warden-sdk/ops/perf/native-state";
import { perfPaths } from "@delacour/warden-sdk/ops/perf/paths";
import { reactCapture } from "@delacour/warden-sdk/ops/perf/react-capture";
import { reportReader } from "@delacour/warden-sdk/ops/perf/report-read";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type UiError, uiOutput } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { hookJson } from "../hooks/json";
import { perfOptionsCli } from "./options";
import type { PerfDeps, PerfOptionValues } from "./run";
import { perfSessionPickCli } from "./session-pick";

export class PerfQueryCli {
	private isRecord(v: unknown): v is Record<string, unknown> {
		return typeof v === "object" && v !== null;
	}

	private arr(v: unknown): unknown[] {
		return Array.isArray(v) ? v : [];
	}

	private num(v: unknown): number | undefined {
		return typeof v === "number" ? v : undefined;
	}

	private str(v: unknown): string | undefined {
		return typeof v === "string" ? v : undefined;
	}

	private sec(ms: number): string {
		return `${(ms / 1000).toFixed(1)}s`;
	}

	private readJson(path: string): unknown {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	}

	private missing(what: string, hint: string): { success: false; error: UiError } {
		return {
			success: false,
			error: uiOutput.uiError("failed", `this session has no ${what}`, { hint }),
		};
	}

	/** `2s-5s` / `2-5` / `500ms-1.5s` / `0-5s` as session-timeline ms. */
	parseWindow(raw: string): { fromMs: number; toMs: number } | undefined {
		const parts = raw.split("-");
		if (parts.length !== 2) return undefined;
		const [a, b] = parts.map((p) => (ZERO.test(p.trim()) ? 0 : perfDuration.parseDuration(p)));
		return a === undefined || b === undefined || b <= a ? undefined : { fromMs: a, toMs: b };
	}

	private readProfile(dir: string): CpuProfile | undefined {
		const parsed = cpuProfileSchema.safeParse(this.readJson(join(dir, "js", "cpu.cpuprofile")));
		return parsed.success ? parsed.data : undefined;
	}

	private readonly anonymous: NamedFrame = (f) => ({ name: f.functionName === "" ? "(anonymous)" : f.functionName });

	readonly nativeReportOf = (dir: string): { platform: "ios" | "android"; report: unknown } | undefined => {
		for (const [platform, file] of [
			["ios", "ios-native.json"],
			["android", "android-native.json"],
		] as const) {
			const path = join(dir, "native", file);
			if (existsSync(path)) return { platform, report: this.readJson(path) };
		}
		return undefined;
	};

	/** One iOS hang as lines: the headline, its top functions and its call chains. */
	private iosHangLines(h: Record<string, unknown>): string[] {
		return [
			`${Math.round(this.num(h.durationMs) ?? 0)}ms @ ${this.sec(this.num(h.atMs) ?? 0)} (trace time) ${this.str(h.kind) ?? ""}`.trimEnd(),
			...this.arr(h.topFunctions)
				.slice(0, 5)
				.flatMap((f) =>
					this.isRecord(f) ? [`  fn ${this.str(f.name) ?? "?"}  ${this.num(f.samples) ?? 0} samples`] : []
				),
			...this.arr(h.chains)
				.slice(0, 3)
				.flatMap((c) => (this.isRecord(c) ? [`  chain ${this.str(c.chain) ?? "?"}  ${this.num(c.samples) ?? 0}`] : [])),
		];
	}

	/** One Android hang as a line: duration, time, jank type and the main-thread state split. */
	private androidHangLine(h: Record<string, unknown>): string {
		const main = this.isRecord(h.main) ? h.main : {};
		const split = Object.entries(main)
			.filter(([, v]) => typeof v === "number" && v > 0)
			.map(([k, v]) => `${k} ${Math.round(Number(v))}ms`)
			.join(", ");
		return `${Math.round(this.num(h.durMs) ?? 0)}ms @ ${this.sec(this.num(h.atMs) ?? 0)} ${this.str(h.jankType) ?? ""}  main: ${split || "n/a"}`;
	}

	/** The hangs of a native analysis JSON as lines: iOS with top functions and call chains, Android with the main-thread state split. */
	hangLines(platform: "ios" | "android", report: unknown): string[] {
		if (!this.isRecord(report)) return [];
		if (platform === "ios")
			return this.arr(report.hangs).flatMap((h) => (this.isRecord(h) ? this.iosHangLines(h) : []));
		const root = report.hangs;
		return (this.isRecord(root) ? this.arr(root.hangs) : []).flatMap((h) =>
			this.isRecord(h) ? [this.androidHangLine(h)] : []
		);
	}

	/** `commits --by component`: renders per component. */
	readonly commitsComponentAnswer = ({ commits, limit }: CommitsQuery): Result<Answer, UiError> => {
		const rows = sessionQuery.commitsByComponent(commits, limit);
		return resultFactory.ok({
			result: { by: "component", rows },
			lines: rows.map(
				(r) =>
					`${r.name}  renders ${r.renders} (mounts ${r.mounts})  self ${r.sumSelfMs}ms  max ${r.maxSelfMs}ms  in ${r.commits} commits${r.memo ? "  memo" : ""}`
			),
		});
	};

	/** `commits --by window`: commits bucketed by `--size` (default 1s). */
	readonly commitsWindowAnswer = ({ commits, opts, limit }: CommitsQuery): Result<Answer, UiError> => {
		const size = opts.size === undefined ? 1000 : perfDuration.parseDuration(opts.size);
		if (size === undefined)
			return { success: false, error: uiOutput.uiError("usage", `--size must be a duration, got "${opts.size}"`) };
		const rows = sessionQuery.commitsByWindow(commits, size, limit);
		return resultFactory.ok({
			result: { by: "window", windowMs: size, rows },
			lines: rows.map(
				(r) =>
					`${this.sec(r.fromMs)}-${this.sec(r.toMs)}  ${r.commits} commits  ${r.renderMs}ms  worst ${r.worstMs}ms  ${r.top.join(", ")}`
			),
		});
	};

	/** `commits --by index [n]`: commits in depth, optionally just one. */
	readonly commitsIndexAnswer = ({ commits, opts, rest, limit }: CommitsQuery): Result<Answer, UiError> => {
		const raw = opts.index ?? rest[0];
		const only = raw === undefined ? undefined : Number(raw);
		if (only !== undefined && !Number.isInteger(only))
			return { success: false, error: uiOutput.uiError("usage", `commit index must be an integer, got "${raw}"`) };
		const rows = sessionQuery.commitsByIndex(commits, {
			...(only === undefined ? {} : { only }),
			...(limit === undefined ? {} : { limit }),
		});
		if (rows.length === 0)
			return { success: false, error: uiOutput.uiError("failed", `no commit #${only} in this session`) };
		return resultFactory.ok({
			result: { by: "index", rows },
			lines: rows.flatMap((r) => [
				`#${r.index} @${this.sec(r.startMs)}  ${r.durationMs}ms  ${r.fibers} fibers${r.updaters.length > 0 ? `  updated by ${r.updaters.join(", ")}` : ""}`,
				...r.top.map((t) => `  ${t.name}  ${t.selfMs}ms  (${t.cause})`),
			]),
		});
	};

	/** `commits --by cascade`: origins whose commits re-rendered fibers through a parent or context. */
	readonly commitsCascadeAnswer = ({ commits, limit }: CommitsQuery): Result<Answer, UiError> => {
		const rows = sessionQuery.commitsCascade(commits, limit);
		return resultFactory.ok({
			result: { by: "cascade", rows },
			lines: rows.map(
				(r) =>
					`${r.origin}  ${r.commits} commits  ${r.cascadeFibers}/${r.fibers} fibers re-rendered by a parent or context  ${r.renderMs}ms`
			),
		});
	};

	private commitsAnswer(dir: string, opts: PerfQueryOptions, rest: readonly string[]): Result<Answer, UiError> {
		const file = reportReader.readCommitsFile(dir);
		if (file === undefined) return this.missing("React profile", "record with --react: warden perf record --react");
		const limit = opts.limit === undefined ? undefined : Number(opts.limit);
		const by = opts.by ?? "component";
		const answer = COMMIT_ANSWERS.get(by);
		if (answer === undefined)
			return {
				success: false,
				error: uiOutput.uiError("usage", `--by must be component, window, index or cascade, got "${by}"`),
			};
		return answer({ commits: file.commits, opts, rest, limit });
	}

	/** `cpu --tree`: the JS call tree. */
	private cpuTreeAnswer(profile: CpuProfile, label: NamedFrame): Result<Answer, UiError> {
		const rows = sessionQuery.cpuTree(profile, label);
		return resultFactory.ok({
			result: { mode: "tree", rows },
			lines: rows.map(
				(r) => `${"  ".repeat(r.depth - 1)}${r.name}  ${r.totalPct}% (${r.totalMs}ms, self ${r.selfMs}ms)`
			),
		});
	}

	/** `cpu --window a-b`: JS self time inside a window of the session timeline. */
	private cpuWindowAnswer(
		profile: CpuProfile,
		label: NamedFrame,
		hotspots: unknown,
		session: PerfSession,
		rawWindow: string | undefined,
		limit: number
	): Result<Answer, UiError> {
		const window = this.parseWindow(rawWindow ?? "");
		if (window === undefined)
			return { success: false, error: uiOutput.uiError("usage", `--window must look like 2s-5s, got "${rawWindow}"`) };
		const anchor =
			this.isRecord(hotspots) && this.isRecord(hotspots.anchor) ? this.num(hotspots.anchor.hostWallMs) : undefined;
		if (anchor === undefined) return this.missing("clock anchor for the JS profile", "re-record with --js");
		const rows = sessionQuery.cpuWindow(
			profile,
			label,
			{ ...window, profileStartMs: anchor - session.startedAt.wallMs },
			limit
		);
		return resultFactory.ok({
			result: { mode: "window", window, rows },
			lines: [
				`JS self time ${this.sec(window.fromMs)}-${this.sec(window.toMs)}`,
				...rows.map((r) => `${r.name}  ${r.selfMs}ms  ${r.selfPct}%`),
			],
		});
	}

	/** The native hotspots of an analysis JSON as name / self-percent rows, per platform shape. */
	private nativeTopRows(
		platform: "ios" | "android",
		report: Record<string, unknown>
	): Array<{ name: string; selfPct: number }> {
		if (platform === "ios") {
			return this.arr(report.hotspots).flatMap((h) =>
				this.isRecord(h)
					? [{ name: `${this.str(h.frame) ?? "?"} (${this.str(h.thread) ?? ""})`, selfPct: this.num(h.selfPct) ?? 0 }]
					: []
			);
		}
		if (this.isRecord(report.cpu)) {
			return this.arr(report.cpu.functions).flatMap((f) =>
				this.isRecord(f)
					? [
							{
								name: `${this.str(f.function) ?? "?"} (${this.str(f.thread) ?? ""})`,
								selfPct: this.num(f.selfPct) ?? 0,
							},
						]
					: []
			);
		}
		return this.arr(report.top).flatMap((r) =>
			this.isRecord(r) ? [{ name: this.str(r.symbol) ?? "?", selfPct: this.num(r.percent) ?? 0 }] : []
		);
	}

	/** `cpu` / `cpu --top`: the hottest JS functions and native symbols. */
	private cpuTopAnswer(hotspots: unknown, native: NativeReport | undefined, limit: number): Result<Answer, UiError> {
		const lines: string[] = [];
		const result: Record<string, unknown> = { mode: "top" };
		if (this.isRecord(hotspots) && Array.isArray(hotspots.topSelf)) {
			const top = (hotspots as unknown as Hotspots).topSelf.slice(0, limit);
			result.js = top;
			lines.push(
				"JS self time:",
				...top.map((f) => `  ${f.name}  ${f.selfPct}%  ${f.mapped ? `${f.file}:${f.line}` : f.file}`)
			);
		}
		if (native !== undefined && this.isRecord(native.report)) {
			const top = this.nativeTopRows(native.platform, native.report).slice(0, limit);
			result.native = top;
			lines.push("native self time:", ...top.map((r) => `  ${r.name}  ${r.selfPct.toFixed(1)}%`));
		}
		return resultFactory.ok({ result, lines });
	}

	private cpuAnswer(dir: string, session: PerfSession, opts: PerfQueryOptions): Result<Answer, UiError> {
		const hotspots = this.readJson(join(dir, "js", "hotspots.json"));
		const profile = this.readProfile(dir);
		const limit = opts.limit === undefined ? 15 : Number(opts.limit);
		const native = this.nativeReportOf(dir);
		if (profile === undefined && native === undefined)
			return this.missing("CPU profile", "record with --js or --native: warden perf record --js");
		const label: NamedFrame = reactCapture.loadCpuCorrelation(join(dir, "js"))?.label ?? this.anonymous;
		if (opts.tree === true || opts.window !== undefined) {
			if (profile === undefined) return this.missing("JS CPU profile", "record with --js: warden perf record --js");
			if (opts.tree === true) return this.cpuTreeAnswer(profile, label);
			return this.cpuWindowAnswer(profile, label, hotspots, session, opts.window, limit);
		}
		return this.cpuTopAnswer(hotspots, native, limit);
	}

	/** Re-run the Perfetto SQL over the session's Android trace, optionally inside `--window`; returns the fresh report. */
	private async rerunHangs(
		ctx: CommandContext,
		deps: PerfDeps,
		session: PerfSession,
		opts: PerfQueryOptions,
		profilers: NativeProfilers
	): Promise<Result<unknown, UiError>> {
		const window = opts.window === undefined ? undefined : this.parseWindow(opts.window);
		if (opts.window !== undefined && window === undefined)
			return {
				success: false,
				error: uiOutput.uiError("usage", `--window must look like 2s-5s, got "${opts.window}"`),
			};
		const profiler = await profilers.android();
		const trace = join(nativeStateFiles.sessionNativeDir(ctx, session.id), "android.perfetto-trace");
		const analysis = await profiler.analyze(ctx, deps, {
			target: {
				udid: session.device.udid,
				platform: "android",
				ownedByCaller: false,
				source: "flag",
				mode: "observe",
			},
			app: session.app?.id ?? "",
			dir: nativeStateFiles.sessionNativeDir(ctx, session.id),
			trace,
			...(window === undefined ? {} : { windowMs: { startMs: window.fromMs, endMs: window.toMs } }),
			...(opts.yes === true ? { yes: true } : {}),
		});
		if (!analysis.success) return analysis;
		return resultFactory.ok(analysis.data.report);
	}

	/** `stacks hang`: the native hangs, optionally re-run from the Android trace. */
	private async hangStackAnswer(
		ctx: CommandContext,
		deps: PerfDeps,
		session: PerfSession,
		opts: PerfQueryOptions,
		native: NativeReport | undefined,
		profilers: NativeProfilers
	): Promise<Result<Answer, UiError>> {
		if (native === undefined)
			return this.missing("native profile", "record with --native: warden perf record --native");
		let report = native.report;
		if (opts.rerun === true) {
			if (native.platform !== "android")
				return {
					success: false,
					error: uiOutput.uiError("usage", "--rerun re-runs the Perfetto SQL: Android sessions only"),
				};
			const rerun = await this.rerunHangs(ctx, deps, session, opts, profilers);
			if (!rerun.success) return rerun;
			report = rerun.data;
		}
		const lines = this.hangLines(native.platform, report);
		return resultFactory.ok({
			result: { sub: "hang", platform: native.platform, report: this.isRecord(report) ? report.hangs : null },
			lines: lines.length > 0 ? lines : ["no hangs"],
		});
	}

	/** The iOS hang call chains that pass through `fn`, as `chain  samples` strings. */
	private nativeChainsThrough(report: Record<string, unknown>, fn: string): string[] {
		return this.arr(report.hangs)
			.flatMap((h) => (this.isRecord(h) ? this.arr(h.chains) : []))
			.flatMap((c) =>
				this.isRecord(c) && this.str(c.chain)?.toLowerCase().includes(fn.toLowerCase())
					? [`${this.str(c.chain)}  ${this.num(c.samples) ?? 0}`]
					: []
			);
	}

	/** `stacks callers <fn>`: who calls `fn` in the JS profile, and which iOS hang chains go through it. */
	private callersStackAnswer(
		dir: string,
		native: NativeReport | undefined,
		fn: string | undefined
	): Result<Answer, UiError> {
		if (fn === undefined)
			return { success: false, error: uiOutput.uiError("usage", "stacks callers needs a function name") };
		const profile = this.readProfile(dir);
		const lines: string[] = [];
		const result: Record<string, unknown> = { sub: "callers", fn };
		if (profile !== undefined) {
			const rows = sessionQuery.jsCallers(
				profile,
				reactCapture.loadCpuCorrelation(join(dir, "js"))?.label ?? this.anonymous,
				fn
			);
			result.js = rows;
			lines.push(
				`JS callers of ${fn}:`,
				...(rows.length === 0 ? ["  none"] : rows.map((r) => `  ${r.caller}  ${r.ms}ms  ${r.pct}%`))
			);
		}
		if (native?.platform === "ios" && this.isRecord(native.report)) {
			const chains = this.nativeChainsThrough(native.report, fn);
			result.native = chains;
			if (chains.length > 0) lines.push(`native chains through ${fn}:`, ...chains.map((c) => `  ${c}`));
		}
		if (profile === undefined && native === undefined)
			return this.missing("CPU profile", "record with --js or --native");
		return resultFactory.ok({ result, lines });
	}

	/** One thread of a native analysis as a line: Perfetto percent, or the Android scheduler state split. */
	private readonly threadLine = (t: unknown): string[] => {
		if (!this.isRecord(t)) return [];
		const name = this.str(t.thread) ?? "?";
		if (this.num(t.pct) !== undefined) return [`${name}  ${this.num(t.pct)}%`];
		return [
			`${name}  running ${Math.round(this.num(t.runningMs) ?? 0)}ms  runnable ${Math.round(this.num(t.runnableMs) ?? 0)}ms  io ${Math.round(this.num(t.ioMs) ?? 0)}ms  sleeping ${Math.round(this.num(t.sleepingMs) ?? 0)}ms`,
		];
	};

	/** `stacks thread`: per-thread CPU of the native profile. */
	private threadStackAnswer(native: NativeReport | undefined): Result<Answer, UiError> {
		if (native === undefined || !this.isRecord(native.report))
			return this.missing("native profile", "record with --native");
		const rows = this.arr(native.report.threads);
		const lines = rows.flatMap(this.threadLine);
		return resultFactory.ok({
			result: { sub: "thread", threads: rows },
			lines: lines.length > 0 ? lines : ["no thread data"],
		});
	}

	/** `stacks leaks`: the iOS leaks of the native profile. */
	private leaksStackAnswer(native: NativeReport | undefined): Result<Answer, UiError> {
		if (native === undefined || !this.isRecord(native.report))
			return this.missing("native profile", "record with --native --leaks (iOS)");
		const leaks = this.arr(native.report.leaks);
		const lines = leaks.flatMap((l) =>
			this.isRecord(l)
				? [
						`${this.str(l.type) ?? "?"}  ${this.num(l.count) ?? 0}x  ${this.num(l.bytes) ?? 0} bytes  at ${this.str(l.frame) ?? "?"}`,
					]
				: []
		);
		return resultFactory.ok({
			result: { sub: "leaks", leaks },
			lines: lines.length > 0 ? lines : ["no leaks recorded"],
		});
	}

	private async stacksAnswer(
		ctx: CommandContext,
		deps: PerfDeps,
		dir: string,
		session: PerfSession,
		opts: PerfQueryOptions,
		rest: readonly string[],
		profilers: NativeProfilers
	): Promise<Result<Answer, UiError>> {
		const sub = rest[0] ?? "hang";
		const native = this.nativeReportOf(dir);
		if (sub === "hang") return this.hangStackAnswer(ctx, deps, session, opts, native, profilers);
		if (sub === "callers") return this.callersStackAnswer(dir, native, rest[1]);
		if (sub === "thread") return this.threadStackAnswer(native);
		if (sub === "leaks") return this.leaksStackAnswer(native);
		return {
			success: false,
			error: uiOutput.uiError("usage", `stacks <hang|callers <fn>|thread|leaks>, got "${sub}"`),
		};
	}

	/** One jank window of the frame stats as a line. */
	private frameWindowLine(w: Record<string, unknown>): string {
		const mark = this.str(w.mark) === undefined ? "" : `  after "${this.str(w.mark)}"`;
		return `  ${this.sec(this.num(w.startOffsetMs) ?? 0)}..${this.sec(this.num(w.endOffsetMs) ?? 0)}  ${this.num(w.missedDeadlineFrameCount) ?? 0} frames over budget, worst ${this.num(w.worstFrameMs) ?? 0}ms${mark}`;
	}

	private framesAnswer(dir: string, opts: PerfQueryOptions): Result<Answer, UiError> {
		const frames = this.readJson(join(dir, "frames.json"));
		const native = this.nativeReportOf(dir);
		if (!this.isRecord(frames) && native === undefined)
			return this.missing("frame data", "record with --frames (Android) or --native: warden perf record --frames");
		const lines: string[] = [];
		const result: Record<string, unknown> = {};
		if (this.isRecord(frames) && frames.status === "ok") {
			const windows = this.arr(frames.worstWindows);
			result.windows = windows;
			lines.push(
				`${this.num(frames.fps) ?? 0} fps, ${this.num(frames.jankPct) ?? 0}% janky, ${this.num(frames.frozenFrames) ?? 0} frozen`,
				...windows.flatMap((w) => (this.isRecord(w) ? [this.frameWindowLine(w)] : []))
			);
		}
		if (native !== undefined) {
			const hangs = this.hangLines(native.platform, native.report).filter((l) => !l.startsWith(" "));
			result.hangs = hangs;
			if (hangs.length > 0) lines.push("hangs:", ...hangs.slice(0, opts.worst === true ? 5 : 10).map((l) => `  ${l}`));
		}
		return resultFactory.ok({ result, lines: lines.length > 0 ? lines : ["no frame data"] });
	}

	/**
	 * `warden perf query <id> <commits|cpu|stacks|frames> …`: drill into a session's files. `commits --by
	 * component|window|index|cascade`, `cpu --top|--window a-b|--tree`, `stacks hang|callers <fn>|thread|leaks`,
	 * `frames --worst`. Reads the session's artifacts (Android hang stacks re-run the Perfetto SQL with `--rerun`). No device.
	 */
	async perfQuery(
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
			const picked = await perfSessionPickCli.pickSession(ctx, deps, opts, id);
			if (!picked.success) return uiOutput.reportError(ctx, meta, picked.error);
			const session = picked.data;
			const dir = perfPaths.sessionDir(ctx, session.id);
			let answer: Result<Answer, UiError>;
			if (topic === "commits") answer = this.commitsAnswer(dir, opts, rest);
			else if (topic === "cpu") answer = this.cpuAnswer(dir, session, opts);
			else if (topic === "stacks") answer = await this.stacksAnswer(ctx, deps, dir, session, opts, rest, profilers);
			else if (topic === "frames") answer = this.framesAnswer(dir, opts);
			else
				answer = {
					success: false,
					error: uiOutput.uiError("usage", `unknown query "${topic}"`, { hint: "commits | cpu | stacks | frames" }),
				};
			if (!answer.success) return uiOutput.reportError(ctx, meta, answer.error);
			return uiOutput.reportOk(ctx, meta, {
				device: { udid: session.device.udid, platform: session.device.platform, name: session.device.name },
				result: {
					sessionId: session.id,
					topic,
					...(this.isRecord(answer.data.result) ? answer.data.result : { result: answer.data.result }),
				},
				text: answer.data.lines.join("\n"),
			});
		} catch (error) {
			return uiOutput.reportError(ctx, meta, uiOutput.uiError("failed", hookJson.errorMessage(error)));
		}
	}

	/** Wire `query` onto `warden perf`. */
	readonly registerQuery = (
		cmd: Commander,
		ctx: CommandContext,
		done: (code: number) => void,
		deps: PerfDeps
	): void => {
		perfOptionsCli
			.withPerfOptions(
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
			)
			.action(async (id, topic, args, opts) => {
				done(await this.perfQuery(ctx, deps, id, topic, args, opts));
			});
	};
}

export const perfQueryCli = new PerfQueryCli();

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

/** A window may start at the session start; `parseDuration` itself rejects 0. */
const ZERO = /^0+(?:\.0+)?(?:ms|s|m)?$/;

type CommitsFile = NonNullable<ReturnType<typeof reportReader.readCommitsFile>>;
type CommitsQuery = {
	commits: CommitsFile["commits"];
	opts: PerfQueryOptions;
	rest: readonly string[];
	limit: number | undefined;
};

const COMMIT_ANSWERS = new Map<string, (q: CommitsQuery) => Result<Answer, UiError>>([
	["component", perfQueryCli.commitsComponentAnswer],
	["window", perfQueryCli.commitsWindowAnswer],
	["index", perfQueryCli.commitsIndexAnswer],
	["cascade", perfQueryCli.commitsCascadeAnswer],
]);

type NativeReport = NonNullable<ReturnType<typeof perfQueryCli.nativeReportOf>>;
