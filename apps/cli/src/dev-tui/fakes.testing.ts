import { EventEmitter } from "node:events";
import type { ScreenInput, ScreenOutput, ScreenProcess } from "./screen";

/** A TTY stdin that records raw-mode changes; `press` feeds bytes as a terminal would. */
export function fakeStdin() {
	const events = new EventEmitter();
	const rawModes: boolean[] = [];
	const input: ScreenInput = {
		isTTY: true,
		setRawMode: (raw) => {
			rawModes.push(raw);
		},
		on: (event, listener) => events.on(event, listener),
		off: (event, listener) => events.off(event, listener),
		resume: () => undefined,
		pause: () => undefined,
	};
	return {
		input,
		rawModes,
		press: (bytes: string) => events.emit("data", new TextEncoder().encode(bytes)),
		listeners: () => events.listenerCount("data"),
	};
}

/** A stdout that keeps every write; `size` can change to simulate a resize. */
export function fakeStdout(cols = 80, rows = 24) {
	const writes: string[] = [];
	const output: ScreenOutput & { columns: number; rows: number } = {
		columns: cols,
		rows,
		write: (data) => {
			writes.push(data);
		},
	};
	return {
		output,
		writes,
		all: () => writes.join(""),
		clear: () => {
			writes.length = 0;
		},
		resize(nextCols: number, nextRows: number) {
			output.columns = nextCols;
			output.rows = nextRows;
		},
	};
}

/** A `process` stand-in: real event semantics, `exit` recorded instead of exiting. */
export function fakeProcess() {
	const events = new EventEmitter();
	const exits: number[] = [];
	const proc: ScreenProcess = {
		on: (event, listener) => events.on(event, listener),
		off: (event, listener) => events.off(event, listener),
		listenerCount: (event) => events.listenerCount(event),
		exit: (code) => {
			exits.push(code);
		},
	};
	return {
		proc,
		exits,
		emit: (event: string, arg?: unknown) => events.emit(event, arg),
		count: (event: string) => events.listenerCount(event),
	};
}

/** Plays raw terminal output into a headless xterm and returns the visible rows (alt screen included). */
export async function replay(data: string, cols: number, rows: number): Promise<string[]> {
	const { Terminal } = await import("@xterm/headless");
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(data, resolve));
	const buffer = term.buffer.active;
	const lines = Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
	term.dispose();
	return lines;
}
