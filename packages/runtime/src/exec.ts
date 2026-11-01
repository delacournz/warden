import { existsSync } from "node:fs";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	/** aborting kills the command (SIGTERM), like a timeout */
	signal?: AbortSignal;
	/** each line of stdout and stderr as it arrives (no trailing newline); the result still carries the whole output */
	onLine?: (line: string) => void;
};

/** Injectable process runner — providers take this so tests can fake `simctl`/`adb`. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Runs commands as child processes. `run` is an arrow property, so it can be passed around as a bare `Exec`. */
export class ProcessExec {
	/** Never throws: a command that cannot start (missing binary, missing cwd) is exit 127 with the reason on stderr. */
	readonly run: Exec = async (cmd, opts = {}) => {
		try {
			const proc = Bun.spawn([...cmd], {
				cwd: opts.cwd,
				env: opts.env ? { ...process.env, ...opts.env } : process.env,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
				timeout: opts.timeoutMs,
				...(opts.signal !== undefined ? { signal: opts.signal } : {}),
			});
			const { onLine } = opts;
			const read = (stream: ReadableStream<Uint8Array>) =>
				onLine ? this.readLines(stream, onLine) : new Response(stream).text();
			const [stdout, stderr, exitCode] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
			return { exitCode, stdout, stderr };
		} catch (error) {
			return { exitCode: 127, stdout: "", stderr: this.spawnFailure(cmd, opts.cwd, error) };
		}
	};

	/** Why `Bun.spawn` threw: a missing cwd reads as `posix_spawn '<binary>'`, so name the directory instead. */
	private spawnFailure(cmd: readonly string[], cwd: string | undefined, error: unknown): string {
		if (cwd !== undefined && !existsSync(cwd)) return `cannot run \`${cmd.join(" ")}\`: no such directory ${cwd}`;
		return `cannot run \`${cmd.join(" ")}\`: ${error instanceof Error ? error.message : String(error)}`;
	}

	/** Read a stream to the end, handing each complete line to `onLine` on the way (the last one even without a newline). */
	private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
		const decoder = new TextDecoder();
		let text = "";
		let pending = "";
		for await (const chunk of stream) {
			const piece = decoder.decode(chunk, { stream: true });
			text += piece;
			const lines = (pending + piece).split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
		const rest = decoder.decode();
		text += rest;
		pending += rest;
		if (pending !== "") onLine(pending);
		return text;
	}
}

export const processExec = new ProcessExec();

/** Formats a failed command for a `Result` error string. */
export class ExecErrors {
	/** `cmd` failed → one-line error string for a `Result`. */
	format(cmd: readonly string[], result: ExecResult): string {
		const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
		return `\`${cmd.join(" ")}\` exited ${result.exitCode}${detail ? `: ${detail}` : ""}`;
	}
}

export const execErrors = new ExecErrors();
