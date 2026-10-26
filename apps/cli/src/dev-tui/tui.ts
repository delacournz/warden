import type { DevMetroMode, DevReady, DevTaskHandle, DevTaskId, DevUi, MetroTerminal } from "../commands/dev-ui";
import type { CommandContext } from "../context";
import type { Spinner } from "../ui";
import { createKeyParser } from "./keys";
import { initialState, type Size } from "./model";
import { reduce, type TuiEvent } from "./reducer";
import { listWidth, render } from "./render";
import { createScreen, type ScreenInput, type ScreenOutput, type ScreenProcess } from "./screen";

export type DevTuiDeps = {
	/** the command context; the returned `ctx` is a copy whose output lands in the task rows */
	ctx: CommandContext;
	stdin?: ScreenInput;
	stdout?: ScreenOutput;
	proc?: ScreenProcess;
	/** terminal size now; default reads `stdout.columns/rows` */
	size?: () => Size;
	now?: () => number;
};

/** `DevUi` plus what the Metro pane (TUI-4) and the actions (TUI-5) plug into. */
export type DevTui = DevUi & {
	/** every raw Metro PTY chunk so far, undecoded (the TUI-4 pane feeds them to xterm) */
	metroChunks(): readonly Uint8Array[];
	/** the Metro PTY handle once `metro.attach` ran: key forwarding and resize */
	metroTerminal(): MetroTerminal | undefined;
};

/** Frames are painted at most this often; events in between coalesce. */
export const FRAME_MS = 16;

/** Smallest PTY Metro is given, however small the terminal is. */
const MIN_PTY = { cols: 20, rows: 5 };

function processAdapter(): ScreenProcess {
	return {
		on: (event, listener) => process.on(event, listener),
		off: (event, listener) => process.off(event, listener),
		listenerCount: (event) => process.listenerCount(event),
		exit: (code) => process.exit(code),
	};
}

function stdinAdapter(): ScreenInput {
	return {
		isTTY: process.stdin.isTTY,
		setRawMode: (raw) => process.stdin.setRawMode?.(raw),
		on: (event, listener) => process.stdin.on(event, listener),
		off: (event, listener) => process.stdin.off(event, listener),
		resume: () => process.stdin.resume(),
		pause: () => process.stdin.pause(),
	};
}

/**
 * The dashboard behind `DevUi`: task list, the selected task's log, footer hints, help overlay. Takes the terminal
 * on creation (restore handlers first) and gives it back in `close()`.
 */
export function createDevTui(deps: DevTuiDeps): DevTui {
	const now = deps.now ?? (() => Date.now());
	const screen = createScreen({
		stdin: deps.stdin ?? stdinAdapter(),
		stdout: deps.stdout ?? process.stdout,
		proc: deps.proc ?? processAdapter(),
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

	const paint = (): void => {
		timer = undefined;
		if (closed) return;
		const size = screen.size();
		if (state.redraw !== drawnRedraw) {
			drawnRedraw = state.redraw;
			screen.invalidate();
		}
		screen.draw(render(state, size.cols, size.rows));
	};
	const schedule = (): void => {
		if (timer !== undefined || closed) return;
		timer = setTimeout(paint, FRAME_MS);
	};

	const dispatch = (event: TuiEvent): void => {
		const before = state;
		state = reduce(state, event);
		if (!before.quitting && state.quitting) quitHandler?.();
		schedule();
	};

	const parser = createKeyParser((key) => dispatch({ type: "key", key, at: now() }));
	screen.onInput((chunk) => parser.feed(chunk));
	screen.onResize((size) => dispatch({ type: "resize", size }));
	paint();

	const currentTask = (): string => {
		if (state.quitting || state.ready) return "session";
		return running[running.length - 1] ?? lastStarted ?? "claim";
	};
	const lineTo = (line: string): void => dispatch({ type: "task:log", id: currentTask(), line });

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

	const metro: DevMetroMode = {
		kind: "pty",
		size: () => {
			const { cols, rows } = screen.size();
			return {
				cols: Math.max(MIN_PTY.cols, cols - listWidth(cols) - 3),
				rows: Math.max(MIN_PTY.rows, rows - 2),
			};
		},
		onData: (chunk) => {
			metroChunks.push(chunk);
		},
		attach: (terminal, exited) => {
			metroTerminal = terminal;
			void exited.then(
				(code) => dispatch({ type: "metro:exit", code, at: now() }),
				() => dispatch({ type: "metro:exit", code: 1, at: now() })
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
		},
		onQuit(handler) {
			quitHandler = handler;
		},
		async close() {
			if (closed) return;
			if (timer !== undefined) clearTimeout(timer);
			closed = true;
			screen.close();
		},
	};
}
