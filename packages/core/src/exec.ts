import { existsSync } from "node:fs";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number };

/** Injectable process runner — providers take this so tests can fake `simctl`/`adb`. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Why `Bun.spawn` threw: a missing cwd reads as `posix_spawn '<binary>'`, so name the directory instead. */
function spawnFailure(cmd: readonly string[], cwd: string | undefined, error: unknown): string {
	if (cwd !== undefined && !existsSync(cwd)) return `cannot run \`${cmd.join(" ")}\`: no such directory ${cwd}`;
	return `cannot run \`${cmd.join(" ")}\`: ${error instanceof Error ? error.message : String(error)}`;
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
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
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
