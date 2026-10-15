import type { Exec, ExecOptions, ExecResult } from "@delacour/warden-core/exec";

/** One recorded `exec` invocation. */
export type ExecCall = { cmd: string[]; opts?: ExecOptions };

export type FakeExecResult = Partial<ExecResult>;
export type FakeExecHandler = [
	prefix: string,
	result: FakeExecResult | ((call: ExecCall) => FakeExecResult | Promise<FakeExecResult>),
];

/**
 * Fake `Exec`: the first handler whose prefix the space-joined command starts with answers (exit 0 and
 * empty output unless overridden); unmatched commands exit 127. Every call is recorded in `calls`.
 */
export function fakeExec(handlers: readonly FakeExecHandler[], calls: ExecCall[] = []): Exec {
	return async (cmd, opts) => {
		const call: ExecCall = opts ? { cmd: [...cmd], opts } : { cmd: [...cmd] };
		calls.push(call);
		const joined = cmd.join(" ");
		const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `fakeExec: no handler for ${joined}` };
		const result = typeof hit[1] === "function" ? await hit[1](call) : hit[1];
		return { exitCode: 0, stdout: "", stderr: "", ...result };
	};
}

export function joined(calls: readonly ExecCall[]): string[] {
	return calls.map((call) => call.cmd.join(" "));
}
