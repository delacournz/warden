import { parseDuration } from "@delacour/warden-core/duration";
import { E2eError } from "./errors";
import type { SpanRunner } from "./runner/span";
import { peekSession } from "./session";

/** Milliseconds, or a duration string (`500ms`, `30s`, `2m`). */
export type RunDuration = string | number;

export type RunOptions = {
	/** working directory; default the spec process's (the project root under `warden e2e`) */
	cwd?: string;
	/** merged over the spec's environment; `undefined` removes a variable */
	env?: Record<string, string | undefined>;
	/** kill the command after this long and throw `TIMEOUT`; default `60s` */
	timeout?: RunDuration;
	/** written to the command's stdin */
	input?: string;
	/** throw `RUN_FAILED` on a non-zero exit; default true. `false` returns the result with `ok: false` */
	check?: boolean;
};

export type RunResult = {
	/** exit code was 0 */
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	/** wall time of the command */
	ms: number;
	/** `stdout` parsed as JSON; throws `INVALID_ARGUMENT` when it is not JSON */
	json(): unknown;
};

/**
 * A shell command (`string`, run with `sh -c`) or an argv (`string[]`, no shell: nothing is expanded or split).
 */
export type RunCommand = string | readonly string[];

export type Run = (command: RunCommand, options?: RunOptions) => Promise<RunResult>;

export type RunDeps = {
	/** times the call as a span in the running attempt's trace */
	span: SpanRunner;
};

const DEFAULT_TIMEOUT_MS = 60_000;
/** how much of stderr (else stdout) a `RUN_FAILED` message quotes */
const MESSAGE_TAIL = 2_000;

const invalid = (message: string): E2eError => new E2eError("INVALID_ARGUMENT", `run: ${message}`);

function timeoutMs(value: RunDuration | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) throw invalid(`timeout must be over 0, got ${String(value)}`);
		return value;
	}
	const parsed = parseDuration(value);
	if (!parsed.success) throw invalid(`timeout: ${parsed.error}`);
	return parsed.data;
}

function argvOf(command: RunCommand): string[] {
	if (typeof command === "string") {
		if (command.trim() === "") throw invalid("command is empty");
		return ["sh", "-c", command];
	}
	if (command.length === 0 || command[0] === "") throw invalid("argv is empty");
	return [...command];
}

/** The program a failure names: an argv's first word, `sh -c` for a shell string. Never the full command (secrets). */
const programOf = (command: RunCommand): string => (typeof command === "string" ? "sh -c" : (command[0] ?? ""));

function envOf(extra: RunOptions["env"]): Record<string, string> {
	const merged: Record<string, string | undefined> = { ...process.env, ...extra };
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value;
	return env;
}

function tail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MESSAGE_TAIL ? `…${trimmed.slice(-MESSAGE_TAIL)}` : trimmed;
}

function resultOf(exitCode: number, stdout: string, stderr: string, ms: number): RunResult {
	return {
		ok: exitCode === 0,
		exitCode,
		stdout,
		stderr,
		ms,
		json() {
			try {
				return JSON.parse(stdout);
			} catch {
				throw invalid(`stdout is not JSON: ${tail(stdout).slice(0, 200) || "(empty)"}`);
			}
		},
	};
}

async function exec(command: RunCommand, options: RunOptions): Promise<RunResult> {
	const argv = argvOf(command);
	const limit = timeoutMs(options.timeout);
	const started = Date.now();
	let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
	try {
		proc = Bun.spawn(argv, {
			cwd: options.cwd,
			env: envOf(options.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new E2eError("RUN_FAILED", `run: could not start ${programOf(command)}: ${reason}`);
	}
	if (options.input !== undefined) proc.stdin.write(options.input);
	await proc.stdin.end();

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, limit);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const result = resultOf(exitCode, stdout, stderr, Date.now() - started);
		if (timedOut) {
			throw new E2eError("TIMEOUT", `run: ${programOf(command)} did not finish within ${limit} ms (killed)`);
		}
		if (!result.ok && options.check !== false) {
			const output = tail(stderr) || tail(stdout);
			throw new E2eError(
				"RUN_FAILED",
				`run: ${programOf(command)} failed with exit ${exitCode}${output === "" ? "" : `\n${output}`}`
			);
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

/** `run` with its span runner injected (tests); specs use {@link run}. */
export function createRun(deps: RunDeps): Run {
	return (command, options = {}) =>
		deps.span("run", () => exec(command, options), {
			verdict: (result) => (result.ok ? { ok: true } : { ok: false, code: "RUN_FAILED" }),
			detail: (result) => ({ exitCode: result.exitCode }),
		});
}

/**
 * Runs a command on the host (the machine running the spec, not the device) and returns its exit code and output.
 * Use it to seed a backend, call a script, or reset state before a test. A non-zero exit throws `RUN_FAILED`
 * (`check: false` returns it instead), a command over `timeout` (default 60 s) is killed and throws `TIMEOUT`.
 * Inside a test it is one `run` span in `trace.jsonl` (exit code only, never the command).
 *
 * @example
 * await run("bun scripts/seed.ts");
 * const { id } = (await run(["bun", "scripts/create-user.ts", "--json"])).json() as { id: string };
 */
export const run: Run = createRun({
	span: (op, fn, options) => peekSession()?.span(op, fn, options) ?? fn(),
});
