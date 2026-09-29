export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number };

/** Injectable process runner — providers take this so tests can fake `simctl`/`adb`. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export const bunExec: Exec = async (cmd, opts = {}) => {
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
};

/** `cmd` failed → one-line error string for a `Result`. */
export function execError(cmd: readonly string[], result: ExecResult): string {
	const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
	return `\`${cmd.join(" ")}\` exited ${result.exitCode}${detail ? `: ${detail}` : ""}`;
}
