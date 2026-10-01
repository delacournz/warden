import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { openStore, type Store } from "@delacour/warden-core/store";
import { Chalk } from "chalk";
import type { CommandContext } from "./context";
import type { Choice, Spinner, Ui } from "./ui";

/** Colourless UI with scripted prompt answers and a log of spinner events + questions asked. */
export type ScriptedUi = Ui & {
	events: string[];
	confirmAnswers: Array<boolean | undefined>;
	selectAnswers: Array<string | undefined>;
};

export function scriptedUi(
	opts: { interactive?: boolean; confirm?: Array<boolean | undefined>; select?: Array<string | undefined> } = {}
): ScriptedUi {
	const ui: ScriptedUi = {
		color: new Chalk({ level: 0 }),
		interactive: opts.interactive ?? false,
		events: [],
		confirmAnswers: [...(opts.confirm ?? [])],
		selectAnswers: [...(opts.select ?? [])],
		spinner: (text): Spinner => {
			ui.events.push(`spin: ${text}`);
			return {
				update: (t) => ui.events.push(`spin: ${t}`),
				log: (line) => ui.events.push(`log: ${line}`),
				succeed: (t) => ui.events.push(`ok: ${t ?? text}`),
				fail: (t) => ui.events.push(`fail: ${t ?? text}`),
				stop: () => ui.events.push("stop"),
			};
		},
		confirm: async (message) => {
			ui.events.push(`confirm: ${message}`);
			return ui.confirmAnswers.shift();
		},
		select: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T | undefined> => {
			ui.events.push(`select: ${message}`);
			const answer = ui.selectAnswers.shift();
			return choices.find((c) => c.value === answer)?.value;
		},
		cancelled: (message) => ui.events.push(`cancelled: ${message}`),
	};
	return ui;
}

export type TestContext = CommandContext & {
	stdout: string[];
	stderr: string[];
	cleanup: () => void;
	db: Store;
};

/** Temp-store command context with captured output. Call `cleanup()` in afterEach. */
export function testContext(argv: string[], overrides: Partial<CommandContext> = {}): TestContext {
	const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
	const db = openStore(join(dir, "warden.db"));
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exec: Exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
	return {
		argv,
		env: { WARDEN_HOME: dir, HOME: dir, WARDEN_BACKGROUND: "0" },
		cwd: dir,
		now: () => 1_000_000,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
		store: () => db,
		exec,
		readStdin: async () => "",
		ui: scriptedUi(),
		...overrides,
		stdout,
		stderr,
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Fake exec: first matching handler (by joined command prefix) wins; unmatched → exit 127. */
export function fakeExec(handlers: Array<[prefix: string, result: Partial<ExecResult>]>, calls: string[][] = []): Exec {
	return async (cmd) => {
		calls.push([...cmd]);
		const joined = cmd.join(" ");
		const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `fakeExec: no handler for ${joined}` };
		return { exitCode: 0, stdout: "", stderr: "", ...hit[1] };
	};
}
