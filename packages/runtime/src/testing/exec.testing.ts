import type { Exec, ExecResult } from "../exec";

/** Fake exec: first matching handler (by joined command prefix) wins; unmatched → exit 127. Every call is pushed to `calls`. */
export function fakeExec(handlers: Array<[prefix: string, result: Partial<ExecResult>]>, calls: string[][] = []): Exec {
	return async (cmd) => {
		calls.push([...cmd]);
		const joined = cmd.join(" ");
		const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `fakeExec: no handler for ${joined}` };
		return { exitCode: 0, stdout: "", stderr: "", ...hit[1] };
	};
}
