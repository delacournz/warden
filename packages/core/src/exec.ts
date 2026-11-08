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

/** Why `Bun.spawn` threw: a missing cwd reads as `posix_spawn '<binary>'`, so name the directory instead. */
function spawnFailure(cmd: readonly string[], cwd: string | undefined, error: unknown): string {
	if (cwd !== undefined && !existsSync(cwd)) return `cannot run \`${cmd.join(" ")}\`: no such directory ${cwd}`;
	return `cannot run \`${cmd.join(" ")}\`: ${error instanceof Error ? error.message : String(error)}`;
}

/** Read a stream to the end, handing each complete line to `onLine` on the way (the last one even without a newline). */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
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

/** Never throws: a command that cannot start (missing binary, missing cwd) is exit 127 with the reason on stderr. */
export const bunExec: Exec = async (cmd, opts = {}) => {
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
			onLine ? readLines(stream, onLine) : new Response(stream).text();
		const [stdout, stderr, exitCode] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
		return { exitCode, stdout, stderr };
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: spawnFailure(cmd, opts.cwd, error) };
	}
};

/** `cmd` failed → one-line error string for a `Result`. */
export function execError(cmd: readonly string[], result: ExecResult): string {
	const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
	return `\`${cmd.join(" ")}\` exited ${result.exitCode}${detail ? `: ${detail}` : ""}`;
}
