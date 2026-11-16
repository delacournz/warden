import type { Exec } from "@delacour/warden-e2e-bench/src/harness/exec";
import type { SuccessCheck } from "./suite.schema";

const DEFAULT_WAIT_MS = 5_000;

/** Shell-style split of a selector: whitespace separates, '…' and "…" group. */
export function splitSelector(selector: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (const ch of selector) {
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) out.push(current);
			current = "";
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) out.push(current);
	return out;
}

/** The `warden` argv (after the CLI path) for one check. */
export function checkArgs(check: SuccessCheck, udid: string): string[] {
	if ("is" in check) return ["ui", "is", ...splitSelector(check.is), check.state, "--udid", udid];
	const timeout = String(check.timeoutMs ?? DEFAULT_WAIT_MS);
	if ("absent" in check)
		return ["ui", "wait", "absent", ...splitSelector(check.absent), "--udid", udid, "--timeout", timeout];
	return ["ui", "wait", ...splitSelector(check.wait), "--udid", udid, "--timeout", timeout];
}

export type CheckResult = { check: SuccessCheck; passed: boolean; output: string };

export type RunChecksInput = {
	checks: readonly SuccessCheck[];
	udid: string;
	bunPath: string;
	cliPath: string;
	/** the agent's warden session, so the checks drive the device under the bench's lease */
	env: Record<string, string | undefined>;
};

/** Runs every check (no short-circuit, so the report shows each one); passed = all exited 0. */
export async function runChecks(
	exec: Exec,
	input: RunChecksInput
): Promise<{ passed: boolean; results: CheckResult[] }> {
	const results: CheckResult[] = [];
	for (const check of input.checks) {
		const ran = await exec.run(input.bunPath, [input.cliPath, ...checkArgs(check, input.udid)], {
			env: input.env,
			timeoutMs: 60_000,
		});
		const output = `${ran.stdout}${ran.stderr}`.trim().split("\n").slice(-5).join("\n");
		results.push({ check, passed: ran.code === 0 && !ran.timedOut, output });
	}
	return { passed: results.every((r) => r.passed), results };
}
