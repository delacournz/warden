import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { createGitFactsCache } from "@delacour/warden-core/git-facts";
import type { HostFacts } from "@delacour/warden-core/host";
import { openStore, type Store } from "@delacour/warden-core/store";
import { Chalk } from "chalk";
import type { CommandContext } from "./context";
import type { Choice, Spinner, Ui } from "./ui";

/** Colourless UI with scripted prompt answers and a log of spinner events + questions asked. */
export type ScriptedUi = Ui & {
	events: string[];
	confirmAnswers: Array<boolean | undefined>;
	selectAnswers: Array<string | undefined>;
	multiselectAnswers: Array<string[] | undefined>;
	/** answers to `text`, in order; an answer `validate` refuses is logged (`invalid: <why>`) and the next one is tried */
	textAnswers: Array<string | undefined>;
};

export function scriptedUi(
	opts: {
		interactive?: boolean;
		rich?: boolean;
		columns?: number;
		confirm?: Array<boolean | undefined>;
		select?: Array<string | undefined>;
		multiselect?: Array<string[] | undefined>;
		text?: Array<string | undefined>;
	} = {}
): ScriptedUi {
	const ui: ScriptedUi = {
		color: new Chalk({ level: 0 }),
		interactive: opts.interactive ?? false,
		rich: opts.rich ?? false,
		columns: opts.columns ?? 80,
		events: [],
		confirmAnswers: [...(opts.confirm ?? [])],
		selectAnswers: [...(opts.select ?? [])],
		multiselectAnswers: [...(opts.multiselect ?? [])],
		textAnswers: [...(opts.text ?? [])],
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
		text: async (message, prompt = {}) => {
			ui.events.push(`text: ${message}${prompt.initialValue !== undefined ? ` [${prompt.initialValue}]` : ""}`);
			for (;;) {
				const answer = ui.textAnswers.shift();
				if (answer === undefined) return undefined;
				const why = prompt.validate?.(answer);
				if (why === undefined) return answer;
				ui.events.push(`invalid: ${why}`);
			}
		},
		select: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T | undefined> => {
			ui.events.push(`select: ${message}`);
			const answer = ui.selectAnswers.shift();
			return choices.find((c) => c.value === answer)?.value;
		},
		multiselect: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T[] | undefined> => {
			const offered = choices.map((c) => `${c.disabled ? "-" : c.selected ? "*" : "+"}${c.value}`).join(" ");
			ui.events.push(`multiselect: ${message} [${offered}]`);
			const answer = ui.multiselectAnswers.shift();
			return answer?.flatMap((v) => choices.find((c) => c.value === v && !c.disabled)?.value ?? []);
		},
		cancelled: (message) => ui.events.push(`cancelled: ${message}`),
	};
	return ui;
}

/** The host every `testContext` budgets from (12 cpu units): capacity never binds by accident, on any CI runner. */
export const TEST_HOST: HostFacts = { totalMem: 64 * 1024 ** 3, perfCores: 20, effCores: 4, os: "darwin" };

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
		env: { WARDEN_HOME: dir, HOME: dir, WARDEN_BACKGROUND: "0", WARDEN_ARRANGE: "0" },
		cwd: dir,
		now: () => 1_000_000,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
		store: () => db,
		exec,
		git: createGitFactsCache(),
		readStdin: async () => "",
		ui: scriptedUi(),
		hostFacts: async () => TEST_HOST,
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
