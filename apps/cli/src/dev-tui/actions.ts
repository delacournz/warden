import type { Result } from "@delacour/warden-types/result";
import { ok } from "@delacour/warden-types/result";
import type { DevReady } from "../commands/dev-ui";
import type { ActionId, HudPerf } from "./model";

/** Why an effect failed; `code` is set for the failures the actions explain in their own words. */
export type ActionFailure = { message: string; code?: "session_active" | "session_not_found" };

export type FxResult<T> = Promise<Result<T, ActionFailure>>;

/** What a started perf session looks like to the row. */
export type PerfStarted = {
	sessionId: string;
	startedAt: number;
	maxDurationMs: number;
	armed: string[];
	failed: string[];
	warnings: string[];
};

/** A stopped session: where the report is and its summary lines. */
export type PerfStopped = { reportPath: string | undefined; lines: string[]; warnings: string[] };

/** A live device-log stream; `done` settles with a reason when it ended by itself. */
export type LogStream = { stop(): void; done: Promise<string | undefined> };

/**
 * Everything an action touches outside the dashboard. The real ones (`actions.effects.ts`) import the heavy modules
 * lazily; tests pass fakes. Effects with a `log` write their progress lines to the action's row.
 */
export type ActionEffects = {
	/** keys to the Metro PTY; false when there is none */
	metroWrite(data: string): boolean;
	reveal(info: DevReady): FxResult<void>;
	/** resolves with the PNG path */
	screenshot(info: DevReady): FxResult<string>;
	openClient(log: (line: string) => void): FxResult<void>;
	reinstall(log: (line: string) => void): FxResult<{ source: string; hash: string }>;
	restartSim(log: (line: string) => void): FxResult<void>;
	restartMetro(log: (line: string) => void): FxResult<string>;
	streamLogs(info: DevReady, onLine: (line: string) => void): LogStream;
	perfStart(info: DevReady, mode: "default" | "all", log: (line: string) => void): FxResult<PerfStarted>;
	perfStop(info: DevReady, sessionId: string, log: (line: string) => void): FxResult<PerfStopped>;
	perfMark(info: DevReady, label: string, log: (line: string) => void): FxResult<void>;
	frames(info: DevReady, log: (line: string) => void): FxResult<void>;
	report(info: DevReady, log: (line: string) => void): FxResult<void>;
};

/** How actions reach the dashboard: rows, the HUD's perf box and the footer prompt (all pure reducer events behind). */
export type ActionSink = {
	start(id: string, title: string): void;
	log(id: string, line: string): void;
	title(id: string, title: string): void;
	ok(id: string, detail?: string): void;
	fail(id: string, error: string): void;
	hudPerf(perf: HudPerf | undefined): void;
	prompt(label: string): void;
};

export type ActionDeps = {
	now(): number;
	/** the session once `ready` arrived */
	ready(): DevReady | undefined;
	sink: ActionSink;
	fx: ActionEffects;
	/** run `fn` every `ms` until the returned stop is called */
	every(fn: () => void, ms: number): () => void;
};

/** Task row id of an action; `reload` logs on the Metro row. */
export function rowOf(name: string): string {
	return `action:${name}`;
}

/** Log lines are flushed to the row this often, as one event. */
export const LOG_FLUSH_MS = 200;

const PERF_TICK_MS = 1000;

/** `4m00s`, `42s`. */
function countdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	return minutes > 0 ? `${minutes}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Recording = { sessionId: string; startedAt: number; endsAt: number; marks: number; stopTicker: () => void };

/**
 * The warden action keys (`r d o s R x c l p P m f g`). Each runs as a task row of its own; the device, Metro and
 * perf work comes from `ActionEffects`. One perf session per device, `R`/`x` are disabled while one records, and
 * `R`/`x`/`c` run one at a time.
 */
export function createActions(deps: ActionDeps) {
	const { sink, fx } = deps;
	const busy = new Set<string>();
	let exclusive: string | undefined;
	let recording: Recording | undefined;
	let streaming: { stream: LogStream; stopFlush: () => void } | undefined;

	const refuse = (name: string, title: string, why: string): void => {
		sink.start(rowOf(name), title);
		sink.fail(rowOf(name), why);
	};

	/** A row that starts, does `work`, and ends ok with its detail or failed with its message. */
	async function task(
		name: string,
		title: string,
		work: (info: DevReady, log: (line: string) => void) => FxResult<string | undefined>,
		opts: { exclusive?: boolean } = {}
	): Promise<boolean> {
		const row = rowOf(name);
		const info = deps.ready();
		if (info === undefined) {
			refuse(name, title, "not ready: wait for the dev client to open");
			return false;
		}
		if (busy.has(name)) {
			sink.log(row, `${title}: still running`);
			return false;
		}
		if (opts.exclusive && exclusive !== undefined) {
			refuse(name, title, `busy: ${exclusive} is still running`);
			return false;
		}
		busy.add(name);
		if (opts.exclusive) exclusive = title;
		sink.start(row, title);
		try {
			const result = await work(info, (line) => sink.log(row, line));
			if (result.success) sink.ok(row, result.data);
			else sink.fail(row, result.error.message);
			return result.success;
		} catch (error) {
			sink.fail(row, errorText(error));
			return false;
		} finally {
			busy.delete(name);
			if (opts.exclusive) exclusive = undefined;
		}
	}

	/** an effect's outcome without its value, as a row's detail */
	const plain = async (pending: FxResult<unknown>): FxResult<undefined> => {
		const result = await pending;
		return result.success ? ok(undefined) : result;
	};

	const reopen = (log: (line: string) => void): FxResult<undefined> => {
		log("reopening the dev client");
		return plain(fx.openClient(log));
	};

	/** A resolved promise (the key was refused, with the reason in its row) while a perf session records; else undefined. */
	function recordingGuard(name: string, title: string): Promise<void> | undefined {
		if (recording === undefined) return undefined;
		refuse(name, title, "disabled while a perf session records (p stops it)");
		return Promise.resolve();
	}

	function stopLogs(): void {
		if (streaming === undefined) return;
		const { stream, stopFlush } = streaming;
		streaming = undefined;
		stopFlush();
		stream.stop();
	}

	async function toggleLogs(): Promise<void> {
		const row = rowOf("logs");
		if (streaming !== undefined) {
			stopLogs();
			sink.ok(row, "stopped");
			return;
		}
		const info = deps.ready();
		if (info === undefined) {
			refuse("logs", "device logs", "not ready: wait for the dev client to open");
			return;
		}
		sink.start(row, "device logs");
		let pending: string[] = [];
		const flush = (): void => {
			if (pending.length === 0) return;
			const lines = pending;
			pending = [];
			sink.log(row, lines.join("\n"));
		};
		let stream: LogStream;
		try {
			stream = fx.streamLogs(info, (line) => pending.push(line));
		} catch (error) {
			sink.fail(row, errorText(error));
			return;
		}
		const stopTicker = deps.every(flush, LOG_FLUSH_MS);
		const current = {
			stream,
			stopFlush: () => {
				stopTicker();
				flush();
			},
		};
		streaming = current;
		void stream.done.then((reason) => {
			if (streaming !== current) return;
			streaming = undefined;
			current.stopFlush();
			if (reason === undefined) sink.ok(row, "log stream ended");
			else sink.fail(row, reason);
		});
	}

	function endRecording(): void {
		recording?.stopTicker();
		recording = undefined;
		sink.hudPerf(undefined);
	}

	function tickPerf(): void {
		const current = recording;
		if (current === undefined) return;
		const left = current.endsAt - deps.now();
		if (left > 0) {
			sink.title(rowOf("perf"), `perf ● ${countdown(left)} left`);
			return;
		}
		endRecording();
		sink.title(rowOf("perf"), "perf");
		sink.log(rowOf("perf"), `session ${current.sessionId} reached its cap; g shows the report`);
		sink.ok(rowOf("perf"));
	}

	/** Begin tracking a started session: HUD box, ticker, the row's title and first lines. */
	function beginRecording(s: PerfStarted): void {
		const row = rowOf("perf");
		recording = {
			sessionId: s.sessionId,
			startedAt: s.startedAt,
			endsAt: s.startedAt + s.maxDurationMs,
			marks: 0,
			stopTicker: deps.every(tickPerf, PERF_TICK_MS),
		};
		sink.hudPerf({ startedAt: s.startedAt, marks: 0 });
		sink.title(row, `perf ● ${countdown(s.maxDurationMs)} left`);
		sink.log(row, `session ${s.sessionId}`);
		const failed = s.failed.length > 0 ? `  failed: ${s.failed.join(", ")}` : "";
		sink.log(row, `armed: ${s.armed.join(", ") || "none yet"}${failed}`);
		sink.log(row, `stops itself after ${countdown(s.maxDurationMs)}; p stops it, m adds a mark`);
		for (const warning of s.warnings) sink.log(row, `warning: ${warning}`);
	}

	async function startPerf(mode: "default" | "all"): Promise<void> {
		const row = rowOf("perf");
		const info = deps.ready();
		if (info === undefined) {
			refuse("perf", "perf", "not ready: wait for the dev client to open");
			return;
		}
		if (busy.has("perf")) {
			sink.log(row, "perf: still busy");
			return;
		}
		busy.add("perf");
		sink.start(row, mode === "all" ? "perf: starting (all)…" : "perf: starting…");
		try {
			const started = await fx.perfStart(info, mode, (line) => sink.log(row, line));
			if (started.success) {
				beginRecording(started.data);
				return;
			}
			const { message, code } = started.error;
			sink.title(row, "perf");
			sink.fail(
				row,
				code === "session_active"
					? `${message}\none perf session per device: stop that one first (warden perf stop)`
					: message
			);
		} catch (error) {
			sink.title(row, "perf");
			sink.fail(row, errorText(error));
		} finally {
			busy.delete("perf");
		}
	}

	async function stopPerf(current: Recording): Promise<void> {
		const row = rowOf("perf");
		const info = deps.ready();
		if (info === undefined || busy.has("perf")) {
			sink.log(row, "perf: still busy");
			return;
		}
		busy.add("perf");
		sink.title(row, "perf: stopping…");
		try {
			const stopped = await fx.perfStop(info, current.sessionId, (line) => sink.log(row, line));
			if (!stopped.success) {
				if (stopped.error.code === "session_not_found") endRecording();
				sink.title(row, "perf");
				sink.fail(row, stopped.error.message);
				return;
			}
			endRecording();
			const { reportPath, lines, warnings } = stopped.data;
			for (const line of lines) sink.log(row, line);
			for (const warning of warnings) sink.log(row, `warning: ${warning}`);
			sink.title(row, "perf");
			sink.ok(row, reportPath);
		} catch (error) {
			sink.title(row, "perf");
			sink.fail(row, errorText(error));
		} finally {
			busy.delete("perf");
		}
	}

	async function togglePerf(mode: "default" | "all"): Promise<void> {
		if (recording === undefined) await startPerf(mode);
		else if (mode === "all") sink.log(rowOf("perf"), "perf is recording: p stops it, then P starts a new one");
		else await stopPerf(recording);
	}

	function askMark(): void {
		if (recording === undefined) refuse("mark", "perf mark", "no perf session recording: p starts one");
		else sink.prompt("mark");
	}

	async function submitMark(label: string): Promise<void> {
		const text = label.trim();
		const current = recording;
		if (text === "" || current === undefined) return;
		await task("mark", "perf mark", async (info, log) => {
			const marked = await fx.perfMark(info, text, log);
			if (!marked.success) return marked;
			current.marks++;
			sink.hudPerf({ startedAt: current.startedAt, marks: current.marks });
			return ok(`marked "${text}"`);
		});
	}

	const reinstall = (): Promise<void> =>
		recordingGuard("reinstall", "reinstall app") ??
		task(
			"reinstall",
			"reinstall app",
			async (_info, log) => {
				log("reinstalling the dev build (Metro keeps running)");
				const installed = await fx.reinstall(log);
				if (!installed.success) return installed;
				log(`installed ${installed.data.source} ${installed.data.hash}`);
				return reopen(log);
			},
			{ exclusive: true }
		).then(() => undefined);

	const restartSim = (): Promise<void> => {
		const blocked = recordingGuard("restart-sim", "restart sim");
		if (blocked) return blocked;
		if (deps.ready()?.platform === "android") {
			refuse("restart-sim", "restart sim", "restarting the emulator is not supported; iOS only");
			return Promise.resolve();
		}
		return task(
			"restart-sim",
			"restart sim",
			async (_info, log) => {
				const restarted = await plain(fx.restartSim(log));
				return restarted.success ? reopen(log) : restarted;
			},
			{ exclusive: true }
		).then(() => undefined);
	};

	const showReport = (): Promise<void> => {
		if (recording === undefined)
			return task("report", "perf report", (info, log) => plain(fx.report(info, log))).then(() => undefined);
		refuse("report", "perf report", "the session is still recording: p stops it, then g");
		return Promise.resolve();
	};

	const handlers: Record<ActionId, () => Promise<void>> = {
		reload: async () => {
			sink.log("metro", fx.metroWrite("r") ? "reload sent (r)" : "reload: Metro is not running");
		},
		show: () =>
			task("show", "show simulator", (info) =>
				info.platform === "ios"
					? plain(fx.reveal(info))
					: Promise.resolve(ok("n/a: Android emulators have no Simulator window"))
			).then(() => undefined),
		open: () => task("open", "open dev client", (_info, log) => plain(fx.openClient(log))).then(() => undefined),
		screenshot: () => task("screenshot", "screenshot", (info) => fx.screenshot(info)).then(() => undefined),
		reinstall,
		"restart-sim": restartSim,
		"metro-clear": () =>
			task("metro-clear", "Metro --clear", (_info, log) => fx.restartMetro(log), { exclusive: true }).then(
				() => undefined
			),
		logs: toggleLogs,
		perf: () => togglePerf("default"),
		"perf-all": () => togglePerf("all"),
		mark: async () => askMark(),
		frames: () =>
			task("frames", "frames", (info, log) =>
				info.platform === "ios"
					? Promise.resolve(ok("the iOS simulator has no frame API; P records native hitches and hangs instead"))
					: plain(fx.frames(info, log))
			).then(() => undefined),
		report: showReport,
	};

	const run = (action: ActionId): Promise<void> => handlers[action]();

	return {
		run,
		submitMark,
		/** the session `p` is recording, if any */
		recording: (): { sessionId: string; startedAt: number; marks: number } | undefined =>
			recording && { sessionId: recording.sessionId, startedAt: recording.startedAt, marks: recording.marks },
		/** stop the log stream and the perf ticker (the dashboard is closing); a recording session is left to the release hook */
		dispose(): void {
			stopLogs();
			recording?.stopTicker();
			recording = undefined;
		},
	};
}
