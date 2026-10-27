import { describe, expect, test } from "bun:test";
import { fakeProcess, fakeStdin, fakeStdout } from "./fakes.testing";
import { createScreen, ENTER, RESTORE } from "./screen";

function setup(cols = 20, rows = 4) {
	const stdin = fakeStdin();
	const stdout = fakeStdout(cols, rows);
	const process = fakeProcess();
	const stderr: string[] = [];
	const screen = createScreen({
		stdin: stdin.input,
		stdout: stdout.output,
		proc: process.proc,
		stderr: (text) => stderr.push(text),
	});
	return { screen, stdin, stdout, process, stderr };
}

const rowsOf = (n: number, text: (y: number) => string): string[] => Array.from({ length: n }, (_, y) => text(y));

describe("createScreen", () => {
	test("enters the alt screen, hides the cursor, turns raw mode on", () => {
		const { stdout, stdin } = setup();
		expect(stdout.all()).toBe(ENTER);
		expect(ENTER).toContain("\x1b[?1049h");
		expect(ENTER).toContain("\x1b[?25l");
		expect(stdin.rawModes).toEqual([true]);
	});

	test("registers its restore handlers before it writes anything", () => {
		const stdin = fakeStdin();
		const stdout = fakeStdout();
		const process = fakeProcess();
		const seen: Record<string, number> = {};
		const original = stdout.output.write;
		stdout.output.write = (data) => {
			for (const event of ["exit", "uncaughtException", "SIGINT", "SIGTERM", "SIGHUP"])
				seen[event] = process.count(event);
			return original(data);
		};
		createScreen({ stdin: stdin.input, stdout: stdout.output, proc: process.proc });
		expect(seen).toEqual({ exit: 1, uncaughtException: 1, SIGINT: 1, SIGTERM: 1, SIGHUP: 1 });
	});

	test("draws a frame inside one synchronized update, one cursor move per row", () => {
		const { screen, stdout } = setup();
		stdout.clear();
		screen.draw(rowsOf(4, (y) => `row${y}`));
		const out = stdout.all();
		expect(out.startsWith("\x1b[?2026h")).toBe(true);
		expect(out.endsWith("\x1b[?2026l")).toBe(true);
		for (let y = 1; y <= 4; y++) expect(out).toContain(`\x1b[${y};1H`);
	});

	test("rewrites only the rows that changed", () => {
		const { screen, stdout } = setup();
		const frame = rowsOf(4, (y) => `row${y}`);
		screen.draw(frame);
		stdout.clear();
		screen.draw(frame);
		expect(stdout.writes).toEqual([]);
		screen.draw(frame.map((row, y) => (y === 2 ? "changed" : row)));
		const out = stdout.all();
		expect(out).toContain("\x1b[3;1Hchanged");
		expect(out).not.toContain("row0");
		expect(out).not.toContain("row1");
		expect(out).not.toContain("row3");
	});

	test("never writes below the last terminal row", () => {
		const { screen, stdout } = setup(20, 4);
		stdout.clear();
		screen.draw(rowsOf(9, (y) => `row${y}`));
		expect(stdout.all()).not.toContain("\x1b[5;1H");
	});

	test("invalidate repaints everything, after a clear", () => {
		const { screen, stdout } = setup();
		const frame = rowsOf(4, (y) => `row${y}`);
		screen.draw(frame);
		screen.invalidate();
		stdout.clear();
		screen.draw(frame);
		expect(stdout.all()).toContain("\x1b[2J");
		expect(stdout.all()).toContain("row3");
	});

	test("SIGWINCH clears, reports the new size and repaints in full", () => {
		const { screen, stdout, process } = setup();
		const sizes: Array<{ cols: number; rows: number }> = [];
		screen.onResize((size) => sizes.push(size));
		const frame = rowsOf(4, (y) => `row${y}`);
		screen.draw(frame);
		stdout.resize(30, 6);
		process.emit("SIGWINCH");
		expect(sizes).toEqual([{ cols: 30, rows: 6 }]);
		stdout.clear();
		screen.draw(rowsOf(6, (y) => `row${y}`));
		expect(stdout.all()).toContain("\x1b[2J");
		expect(stdout.all()).toContain("\x1b[6;1Hrow5");
	});

	test("forwards stdin bytes", () => {
		const { screen, stdin } = setup();
		const got: string[] = [];
		screen.onInput((chunk) => got.push(new TextDecoder().decode(chunk as Uint8Array)));
		stdin.press("q");
		expect(got).toEqual(["q"]);
	});

	test("close restores the terminal once and stops drawing", () => {
		const { screen, stdout, stdin, process } = setup();
		stdout.clear();
		screen.close();
		screen.close();
		expect(stdout.all()).toBe(RESTORE);
		expect(RESTORE.endsWith("\x1b[?2026l\x1b[?25h\x1b[?1049l")).toBe(true);
		expect(stdin.rawModes).toEqual([true, false]);
		expect(stdin.listeners()).toBe(0);
		expect(process.count("exit")).toBe(0);
		stdout.clear();
		screen.draw(["after close"]);
		expect(stdout.writes).toEqual([]);
	});

	test("restores on process exit", () => {
		const { stdout, process } = setup();
		stdout.clear();
		process.emit("exit");
		expect(stdout.all()).toBe(RESTORE);
	});

	test("restores on an uncaught exception, reports it and exits 1", () => {
		const { stdout, process, stderr } = setup();
		stdout.clear();
		process.emit("uncaughtException", new Error("kaput"));
		expect(stdout.all()).toBe(RESTORE);
		expect(stderr.join("")).toContain("kaput");
		expect(process.exits).toEqual([1]);
	});

	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		test(`${signal} restores and exits ${code} when nothing else handles it`, () => {
			const { stdout, process } = setup();
			stdout.clear();
			process.emit(signal);
			expect(stdout.all()).toBe(RESTORE);
			expect(process.exits).toEqual([code]);
		});
	}

	test("a signal restores but leaves the exit to whoever else listens", () => {
		const { stdout, process } = setup();
		let handled = 0;
		process.proc.on("SIGINT", () => {
			handled++;
		});
		stdout.clear();
		process.emit("SIGINT");
		expect(stdout.all()).toBe(RESTORE);
		expect(handled).toBe(1);
		expect(process.exits).toEqual([]);
	});
});
