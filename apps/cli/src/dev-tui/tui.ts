import { ok } from "@delacour/warden-types/result";
import type { DevMetroMode, DevReady, DevTaskHandle, DevTaskId, DevUi, MetroTerminal } from "../commands/dev-ui";
import type { CommandContext } from "../context";
import type { Spinner } from "../ui";
import { createActions } from "./actions";
import { createActionEffects } from "./actions.effects";
import type { HudDeps } from "./hud";
import { createKeyRouter } from "./key-router";
import { createKeyParser } from "./keys";
import { createMetroPane } from "./metro-pane";
import { initialState, type Size } from "./model";
import { reduce, type TuiEvent } from "./reducer";
import { listWidth, paneCursor, type RenderPane, render, tickInterval } from "./render";
import {
	createScreen,
	nodeProcess,
	nodeStdin,
	type ScreenInput,
	type ScreenOutput,
	type ScreenProcess,
} from "./screen";
import { createSession } from "./session";

export type DevTuiDeps = {
	/** the command context; the returned `ctx` is a copy whose output lands in the task rows */
	ctx: CommandContext;
	stdin?: ScreenInput;
	stdout?: ScreenOutput;
	proc?: ScreenProcess;
	/** terminal size now; default reads `stdout.columns/rows` */
	size?: () => Size;
	now?: () => number;
	/** the perf HUD (`--hud`, `--hud-interval`); off or absent = no ticker until `h` / `setHud(true)` */
	hud?: { enabled: boolean; intervalMs: number };
	/** test seams for the HUD ticker: the sampler, frame source and scheduler */
	hudSeams?: Pick<HudDeps, "sampler" | "fps" | "schedule" | "fpsEvery">;
};

/** `DevUi` plus what the Metro pane and the action keys plug into. */
export type DevTui = DevUi & {
	/** every raw Metro PTY chunk so far, undecoded (the pane feeds them to xterm) */
	metroChunks(): readonly Uint8Array[];
	/** the Metro PTY handle once `metro.attach` ran: key forwarding and resize */
	metroTerminal(): MetroTerminal | undefined;
};

/** warden lines the dashboard keeps for the terminal after a failure; the tail of them after a Metro death. */
const TRANSCRIPT_LINES = 400;
const TRANSCRIPT_TAIL = 20;

/** Frames are painted at most this often; events in between coalesce. */
export const FRAME_MS = 16;

/** Smallest PTY Metro is given, however small the terminal is. */
const MIN_PTY = { cols: 20, rows: 5 };

/** Rows above and below the Metro pane: header, the pane's title row, footer. */
const PANE_CHROME_ROWS = 3;

/**
 * The dashboard behind `DevUi`: task list, the selected task's log, footer hints, help overlay. Takes the terminal
 * on creation (restore handlers first) and gives it back in `close()`.
 */
export function createDevTui(deps: DevTuiDeps): DevTui {
	const now = deps.now ?? (() => Date.now());
	const screen = createScreen({
		stdin: deps.stdin ?? nodeStdin(),
		stdout: deps.stdout ?? process.stdout,
		proc: deps.proc ?? nodeProcess(),
		...(deps.size ? { size: deps.size } : {}),
	});

	let state = initialState(screen.size(), now());
	let quitHandler: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let drawnRedraw = state.redraw;
	const running: string[] = [];
	let lastStarted: string | undefined;
	const metroChunks: Uint8Array[] = [];
	let metroTerminal: MetroTerminal | undefined;

	const paneSize = (): { cols: number; rows: number } => {
		const { cols, rows } = screen.size();
		return {
			cols: Math.max(MIN_PTY.cols, cols - listWidth(cols) - 3),
			rows: Math.max(MIN_PTY.rows, rows - PANE_CHROME_ROWS),
		};
	};
	const pane = createMetroPane(paneSize());

	/** The pane as the renderer takes it; only built while the metro row is on screen. */
	const livePane = (): RenderPane | undefined =>
		state.tasks[state.selected]?.id === "metro" ? { rows: pane.rows(), cursor: pane.cursor() } : undefined;

	const resizePane = (): void => {
		const size = paneSize();
		pane.resize(size.cols, size.rows);
		metroTerminal?.resize(size.cols, size.rows);
	};

	const paint = (): void => {
		timer = undefined;
		if (closed) return;
		const size = screen.size();
		if (state.redraw !== drawnRedraw) {
			drawnRedraw = state.redraw;
			screen.invalidate();
		}
		const metro = livePane();
		screen.draw(
			render(state, size.cols, size.rows, metro),
			metro ? paneCursor(state, size.cols, metro.cursor) : undefined
		);
	};
	const schedule = (): void => {
		if (timer !== undefined || closed) return;
		timer = setTimeout(paint, FRAME_MS);
	};

	/** The clock: ticks only while something on screen follows it (a spinner, a running duration, a flash). */
	let clock: { handle: ReturnType<typeof setInterval>; ms: number } | undefined;
	const syncClock = (): void => {
		const ms = closed ? undefined : tickInterval(state);
		if (clock !== undefined && clock.ms === ms) return;
		if (clock !== undefined) clearInterval(clock.handle);
		clock = undefined;
		if (ms === undefined) return;
		const handle = setInterval(() => dispatch({ type: "tick", at: now() }), ms);
		(handle as { unref?: () => void }).unref?.();
		clock = { handle, ms };
	};

	const session = createSession({
		ctx: deps.ctx,
		now,
		hudIntervalMs: deps.hud?.intervalMs,
		hudSeams: deps.hudSeams,
		onSample: (sample, fps) => dispatch({ type: "hud:sample", sample, fps, at: now() }),
	});

	function dispatch(event: TuiEvent): void {
		const before = state;
		state = reduce(state, event);
		if (!before.quitting && state.quitting) quitHandler?.();
		if (before.hud.visible !== state.hud.visible) session.syncHud(state.hud.visible && !closed);
		session.record(event);
		syncClock();
		schedule();
	}

	state = { ...state, hud: { ...state.hud, visible: deps.hud?.enabled === true } };
	session.syncHud(state.hud.visible);

	/** `M` / `c` / `warden dev restart-metro` end the old Metro on purpose: that exit is not the session's. */
	let metroSwap = false;
	const effects = createActionEffects({
		ctx: deps.ctx,
		host: () => state.ready?.actions,
		metroTerminal: () => metroTerminal,
		shotsDir: () => session.shotsDir(),
	});
	const actions = createActions({
		now,
		ready: () => state.ready,
		sink: {
			start: (id, title) => dispatch({ type: "task:start", id, title, at: now() }),
			log: (id, line) => dispatch({ type: "task:log", id, line }),
			title: (id, title) => dispatch({ type: "task:title", id, title }),
			ok: (id, detail) => dispatch({ type: "task:ok", id, detail, at: now() }),
			fail: (id, error) => dispatch({ type: "task:fail", id, error, at: now() }),
			hudPerf: (perf) => dispatch({ type: "hud:perf", perf }),
			prompt: (label) => dispatch({ type: "prompt:open", label }),
		},
		fx: {
			...effects,
			restartMetro: async (log, clear) => {
				metroSwap = true;
				try {
					return await effects.restartMetro(log, clear);
				} finally {
					metroSwap = false;
				}
			},
		},
		every: (fn, ms) => {
			const handle = setInterval(fn, ms);
			return () => clearInterval(handle);
		},
	});

	const routeKey = createKeyRouter({
		state: () => state,
		now,
		dispatch,
		schedule,
		metroTerminal: () => metroTerminal,
		pane,
		paneRows: () => paneSize().rows,
		run: (action) => void actions.run(action),
		submitPrompt: (text) => void actions.submitMark(text),
	});

	const parser = createKeyParser(routeKey);
	screen.onInput((chunk) => parser.feed(chunk));
	screen.onResize((size) => {
		dispatch({ type: "resize", size });
		resizePane();
	});
	paint();

	const currentTask = (): string => {
		if (state.quitting || state.ready) return "session";
		return running[running.length - 1] ?? lastStarted ?? "claim";
	};
	/** warden's own lines, for the terminal after the dashboard closes on a failure (they lived only in the alt screen) */
	const transcript: string[] = [];
	const lineTo = (line: string): void => {
		if (transcript.push(line) > TRANSCRIPT_LINES) transcript.shift();
		dispatch({ type: "task:log", id: currentTask(), line });
	};

	const ui = deps.ctx.ui;
	const spinner = (text: string): Spinner => {
		lineTo(text);
		return {
			update: (next) => dispatch({ type: "task:title", id: currentTask(), title: next }),
			log: lineTo,
			succeed: (next) => {
				if (next) lineTo(next);
			},
			fail: (next) => {
				if (next) lineTo(next);
			},
			stop: () => undefined,
		};
	};
	const ctx: CommandContext = {
		...deps.ctx,
		out: lineTo,
		err: lineTo,
		ui: { ...ui, interactive: false, rich: false, spinner },
	};

	/** The pane's latest `Bundled …` line to the HUD, once per change. */
	let lastBundle: { ms: number; modules: number } | undefined;
	const publishBundle = (): void => {
		if (closed) return;
		const info = pane.bundleInfo();
		if (!info || (info.ms === lastBundle?.ms && info.modules === lastBundle.modules)) return;
		lastBundle = { ms: info.ms, modules: info.modules };
		dispatch({ type: "hud:bundle", bundle: lastBundle });
	};

	const metro: DevMetroMode = {
		kind: "pty",
		size: paneSize,
		onData: (chunk) => {
			metroChunks.push(chunk);
			session.metro(chunk);
			if (!closed) void pane.write(chunk).then(publishBundle).then(schedule);
		},
		attach: (terminal, exited) => {
			metroTerminal = terminal;
			void exited.then(
				(code) => {
					if (!metroSwap) dispatch({ type: "metro:exit", code, at: now() });
				},
				() => {
					if (!metroSwap) dispatch({ type: "metro:exit", code: 1, at: now() });
				}
			);
		},
	};

	return {
		ctx,
		metro,
		metroChunks: () => metroChunks,
		metroTerminal: () => metroTerminal,
		task(id: DevTaskId, label: string): DevTaskHandle {
			let ended = false;
			lastStarted = id;
			running.push(id);
			dispatch({ type: "task:start", id, title: label, at: now() });
			const end = (event: TuiEvent): void => {
				if (ended) return;
				ended = true;
				const index = running.lastIndexOf(id);
				if (index !== -1) running.splice(index, 1);
				dispatch(event);
			};
			return {
				ok: (detail) => end({ type: "task:ok", id, detail, at: now() }),
				fail: (error) => end({ type: "task:fail", id, error, at: now() }),
				log: (line) => dispatch({ type: "task:log", id, line }),
			};
		},
		ready(info: DevReady): void {
			dispatch({ type: "ready", info, at: now() });
			session.ready(info);
		},
		onQuit(handler) {
			quitHandler = handler;
		},
		setHud(on) {
			if (state.hud.visible !== on) dispatch({ type: "hud:visible", on });
			return ok(undefined);
		},
		hudOn: () => session.hudOn(),
		restartMetro: (clear) => actions.restartMetro(clear),
		async close() {
			if (closed) return;
			if (timer !== undefined) clearTimeout(timer);
			closed = true;
			syncClock();
			actions.dispose();
			session.close();
			pane.dispose();
			screen.close();
			replayFailure();
		},
	};

	/**
	 * The dashboard closing on a failure (the session never came up, or Metro died) would take every message
	 * with it: print warden's lines (all of them before `ready`, the tail after) to the real stderr, then the log dir.
	 */
	function replayFailure(): void {
		const quit = state.quitting;
		const metroDied = state.metroExit !== undefined && state.metroExit !== 0;
		const neverReady = state.ready === undefined;
		if (quit || (!neverReady && !metroDied)) return;
		const lines = neverReady ? transcript : transcript.slice(-TRANSCRIPT_TAIL);
		for (const line of lines) deps.ctx.err(line);
		const logDir = session.logDir();
		if (logDir !== undefined) deps.ctx.err(`session log: ${logDir}`);
	}
}
