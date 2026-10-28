import type { Size } from "./model";

const ESC = "\x1b";

/**
 * Alt screen on, alternate scroll off, autowrap off, cursor hidden, cleared. Alternate scroll (`?1007`, on by default in
 * most terminals) turns the mouse wheel into ↑/↓ inside the alt screen, which would move the task selection.
 */
export const ENTER = `${ESC}[?1049h${ESC}[?1007l${ESC}[?7l${ESC}[?25l${ESC}[2J${ESC}[H`;
/**
 * Back to the user's terminal: reset SGR, autowrap on, alternate scroll back on (the terminals' default), end any
 * synchronized update, cursor shown, alt screen off.
 */
export const RESTORE = `${ESC}[0m${ESC}[?7h${ESC}[?1007h${ESC}[?2026l${ESC}[?25h${ESC}[?1049l`;
const BEGIN_SYNC = `${ESC}[?2026h`;
const END_SYNC = `${ESC}[?2026l`;

/** The slice of a TTY input the screen needs. */
export type ScreenInput = {
	isTTY?: boolean;
	setRawMode?(raw: boolean): unknown;
	on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
	off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
	resume(): unknown;
	pause(): unknown;
};

/** The slice of a TTY output the screen needs. */
export type ScreenOutput = {
	write(data: string): unknown;
	columns?: number;
	rows?: number;
};

/** The slice of `process` the screen needs (events, listener counts, exit). */
export type ScreenProcess = {
	on(event: string, listener: (arg?: unknown) => void): unknown;
	off(event: string, listener: (arg?: unknown) => void): unknown;
	listenerCount(event: string): number;
	exit(code: number): unknown;
};

export type ScreenDeps = {
	stdin: ScreenInput;
	stdout: ScreenOutput;
	proc: ScreenProcess;
	/** terminal size now; default reads `stdout.columns/rows` */
	size?: () => Size;
	/** where an uncaught error is reported once the terminal is back */
	stderr?: (text: string) => void;
};

export type Screen = {
	size(): Size;
	/**
	 * write the rows that differ from the last frame; no-op once closed. `cursor` (0-based column and row) shows the real
	 * terminal cursor there after the frame; without it the cursor stays hidden.
	 */
	draw(rows: string[], cursor?: { x: number; y: number }): void;
	/** forget the last frame and clear: the next `draw` repaints everything */
	invalidate(): void;
	onInput(listener: (chunk: Uint8Array | string) => void): void;
	onResize(listener: (size: Size) => void): void;
	close(): void;
};

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * Takes the terminal: alt screen, hidden cursor, raw stdin. The restore handlers (exit, uncaught exception,
 * SIGINT/SIGTERM/SIGHUP) are registered before anything is written, so no failure leaves the terminal in the alt screen.
 */
export function createScreen(deps: ScreenDeps): Screen {
	const { stdin, stdout, proc } = deps;
	const readSize = deps.size ?? ((): Size => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }));
	let closed = false;
	let rawSet = false;
	let last: string[] = [];
	let clearNext = false;
	let cursorSeq = `${ESC}[?25l`;
	const inputListeners: Array<(chunk: Uint8Array | string) => void> = [];
	const resizeListeners: Array<(size: Size) => void> = [];

	const onData = (chunk: Uint8Array | string): void => {
		for (const listener of inputListeners) listener(chunk);
	};
	const onWinch = (): void => {
		if (closed) return;
		last = [];
		clearNext = true;
		const size = readSize();
		for (const listener of resizeListeners) listener(size);
	};

	const restore = (): void => {
		if (closed) return;
		closed = true;
		if (rawSet) {
			try {
				stdin.setRawMode?.(false);
			} catch {
				// the stream may already be gone
			}
		}
		stdin.off("data", onData);
		stdin.pause();
		stdout.write(RESTORE);
		for (const [event, listener] of handlers) proc.off(event, listener);
	};

	const onSignal = (signal: string) => (): void => {
		restore();
		if (proc.listenerCount(signal) === 0) proc.exit(SIGNAL_EXIT[signal] ?? 1);
	};
	const handlers: Array<[string, (arg?: unknown) => void]> = [
		["exit", restore],
		[
			"uncaughtException",
			(error) => {
				restore();
				(deps.stderr ?? ((text: string) => process.stderr.write(text)))(
					`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
				);
				proc.exit(1);
			},
		],
		["SIGINT", onSignal("SIGINT")],
		["SIGTERM", onSignal("SIGTERM")],
		["SIGHUP", onSignal("SIGHUP")],
		["SIGWINCH", onWinch],
	];
	for (const [event, listener] of handlers) proc.on(event, listener);

	stdout.write(ENTER);
	if (stdin.isTTY === true && stdin.setRawMode) {
		stdin.setRawMode(true);
		rawSet = true;
	}
	stdin.on("data", onData);
	stdin.resume();

	return {
		size: readSize,
		draw(rows, cursor) {
			if (closed) return;
			const { rows: height } = readSize();
			let out = clearNext ? `${ESC}[2J` : "";
			clearNext = false;
			for (let y = 0; y < Math.min(rows.length, height); y++) {
				const row = rows[y] ?? "";
				if (last[y] === row) continue;
				out += `${ESC}[${y + 1};1H${row}${ESC}[0m`;
				last[y] = row;
			}
			const wanted = cursor ? `${ESC}[${cursor.y + 1};${cursor.x + 1}H${ESC}[?25h` : `${ESC}[?25l`;
			if (out || wanted !== cursorSeq) {
				cursorSeq = wanted;
				stdout.write(`${BEGIN_SYNC}${out}${wanted}${END_SYNC}`);
			}
		},
		invalidate() {
			if (closed) return;
			last = [];
			clearNext = true;
		},
		onInput: (listener) => {
			inputListeners.push(listener);
		},
		onResize: (listener) => {
			resizeListeners.push(listener);
		},
		close: restore,
	};
}
