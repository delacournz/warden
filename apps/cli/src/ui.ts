import { cancel, confirm, isCancel, type Option, select } from "@clack/prompts";
import { Chalk, type ChalkInstance } from "chalk";
import ora from "ora";

/** A long-running step: shows as a spinner on an interactive stderr, one line otherwise. */
export type Spinner = {
	update: (text: string) => void;
	/** print a line above the spinner without garbling it */
	log: (line: string) => void;
	succeed: (text?: string) => void;
	fail: (text?: string) => void;
	stop: () => void;
};

export type Choice<T extends string> = { value: T; label: string; hint?: string };

/** Terminal presentation: colours, spinners, prompts — all on stderr, so stdout stays clean for `--json`. Injected so tests stay plain and scripted. */
export type Ui = {
	color: ChalkInstance;
	/** true when prompts can be shown (stdin + stderr are TTYs) */
	interactive: boolean;
	spinner: (text: string) => Spinner;
	/** undefined = cancelled (Ctrl-C / Esc) */
	confirm: (message: string, initialValue?: boolean) => Promise<boolean | undefined>;
	select: <T extends string>(message: string, choices: Choice<T>[]) => Promise<T | undefined>;
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

export function terminalUi(env: Record<string, string | undefined>): Ui {
	const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
	return {
		color: new Chalk({ level: colorLevel(env, process.stdout.isTTY === true) }),
		interactive,
		spinner: (text) => {
			const s = ora({ text, stream: process.stderr, isEnabled: process.stderr.isTTY === true && !env.CI }).start();
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
					s.succeed(t);
				},
				fail: (t) => {
					s.fail(t);
				},
				stop: () => {
					s.stop();
				},
			};
		},
		confirm: async (message, initialValue = false) => {
			const answer = await confirm({ message, initialValue, output: process.stderr });
			return isCancel(answer) ? undefined : answer;
		},
		select: async <T extends string>(message: string, choices: Choice<T>[]): Promise<T | undefined> => {
			const answer = await select<T>({
				message,
				output: process.stderr,
				options: choices.map((c): Option<T> => {
					const option: { value: T; label: string; hint?: string } = { value: c.value, label: c.label };
					if (c.hint) option.hint = c.hint;
					return option as Option<T>;
				}),
			});
			return isCancel(answer) ? undefined : answer;
		},
		cancelled: (message) => cancel(message, { output: process.stderr }),
	};
}
