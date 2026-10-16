import type { Option } from "@clack/prompts";
import { Chalk, type ChalkInstance } from "chalk";

/** Memoised on first call. */
function lazy<T>(load: () => T): () => T {
	let value: T | undefined;
	return () => {
		value ??= load();
		return value;
	};
}

/**
 * ora and @clack/prompts (≈35 modules, 15–20 ms) only matter when a command shows a spinner or asks a question, so
 * they load on first use rather than for every `warden` invocation (hooks, heartbeats, `ls`). `require`, not
 * `import()`: `spinner` and `cancelled` are synchronous.
 */
const loadOra = lazy(() => (require("ora") as typeof import("ora")).default);
const loadClack = lazy(() => require("@clack/prompts") as typeof import("@clack/prompts"));

/** The glyphs every command shares with the `warden batch` grid. */
export const SYMBOLS = { ok: "✓", fail: "✗", warn: "!", run: "▶", idle: "·" } as const;

/** A long-running step: shows as a spinner on an interactive stderr, one line otherwise. */
export type Spinner = {
	update: (text: string) => void;
	/** print a line above the spinner without garbling it */
	log: (line: string) => void;
	succeed: (text?: string) => void;
	fail: (text?: string) => void;
	stop: () => void;
};

export type Choice<T extends string> = {
	value: T;
	label: string;
	hint?: string;
	disabled?: boolean;
	/** multiselect: starts ticked */
	selected?: boolean;
};

/** Terminal presentation: colours, spinners, prompts — all on stderr, so stdout stays clean for `--json`. Injected so tests stay plain and scripted. */
export type Ui = {
	color: ChalkInstance;
	/** true when prompts can be shown (stdin + stderr are TTYs) */
	interactive: boolean;
	/** true when a person is watching (stdout + stderr are TTYs): headings and status glyphs are added; piped output stays bare */
	rich: boolean;
	/** terminal width in columns (80 when unknown) */
	columns: number;
	spinner: (text: string) => Spinner;
	/** undefined = cancelled (Ctrl-C / Esc) */
	confirm: (message: string, initialValue?: boolean) => Promise<boolean | undefined>;
	select: <T extends string>(message: string, choices: Choice<T>[]) => Promise<T | undefined>;
	/** space toggles, enter submits; `selected` choices start ticked, disabled ones show but can't be picked. undefined = cancelled */
	multiselect: <T extends string>(message: string, choices: Choice<T>[]) => Promise<T[] | undefined>;
	/** clack's cancel line */
	cancelled: (message: string) => void;
};

/** chalk level for stderr/stdout: honours NO_COLOR / FORCE_COLOR, else colour only on a TTY. */
export function colorLevel(env: Record<string, string | undefined>, isTTY: boolean): 0 | 1 | 2 | 3 {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
	const forced = env.FORCE_COLOR;
	if (forced !== undefined)
		return forced === "0" || forced === "false" ? 0 : forced === "3" ? 3 : forced === "1" ? 1 : 2;
	if (env.TERM === "dumb") return 0;
	return isTTY ? 3 : 0;
}

/** Headings + glyphs only for a person at a terminal: both streams are TTYs, not CI, not a dumb terminal. */
export function isRich(env: Record<string, string | undefined>, outTTY: boolean, errTTY: boolean): boolean {
	return outTTY && errTTY && !env.CI && env.TERM !== "dumb";
}

function toOption<T extends string>(c: Choice<T>): Option<T> {
	const option: { value: T; label: string; hint?: string; disabled?: boolean } = { value: c.value, label: c.label };
	if (c.hint) option.hint = c.hint;
	if (c.disabled) option.disabled = true;
	return option as Option<T>;
}

export function terminalUi(env: Record<string, string | undefined>): Ui {
	const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
	const color = new Chalk({ level: colorLevel(env, process.stdout.isTTY === true) });
	return {
		color,
		interactive,
		rich: isRich(env, process.stdout.isTTY === true, process.stderr.isTTY === true),
		columns: process.stdout.columns ?? process.stderr.columns ?? 80,
		spinner: (text) => {
			const s = loadOra()({
				text,
				color: "cyan",
				stream: process.stderr,
				isEnabled: process.stderr.isTTY === true && !env.CI,
			}).start();
			return {
				update: (t) => {
					s.text = t;
				},
				log: (line) => {
					if (s.isSpinning) {
						s.clear();
						process.stderr.write(`${line}\n`);
						s.render();
					} else process.stderr.write(`${line}\n`);
				},
				succeed: (t) => {
					s.stopAndPersist({ symbol: color.green(SYMBOLS.ok), text: t ?? s.text });
				},
				fail: (t) => {
					s.stopAndPersist({ symbol: color.red(SYMBOLS.fail), text: t ?? s.text });
				},
				stop: () => {
					s.stop();
				},
			};
		},
		confirm: async (message, initialValue = false) => {
			const { confirm, isCancel } = loadClack();
			const answer = await confirm({ message, initialValue, output: process.stderr });
			return isCancel(answer) ? undefined : answer;
		},
		select: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T | undefined> => {
			const { select, isCancel } = loadClack();
			const answer = await select<T>({ message, output: process.stderr, options: choices.map(toOption) });
			return isCancel(answer) ? undefined : answer;
		},
		multiselect: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T[] | undefined> => {
			const { multiselect, isCancel } = loadClack();
			const answer = await multiselect<T>({
				message,
				output: process.stderr,
				required: false,
				initialValues: choices.filter((c) => c.selected && !c.disabled).map((c) => c.value),
				options: choices.map(toOption),
			});
			return isCancel(answer) ? undefined : answer;
		},
		cancelled: (message) => loadClack().cancel(message, { output: process.stderr }),
	};
}
