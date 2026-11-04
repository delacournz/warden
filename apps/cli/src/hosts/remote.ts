import { mkdirSync } from "node:fs";
import { claimError } from "@delacour/warden-core/claim-errors";
import type { ExecResult } from "@delacour/warden-core/exec";
import { getHost, type HostRecord } from "@delacour/warden-core/hosts/registry";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { currentBuild } from "../update/build-info";
import { classifySshFailure, hostControlDir, sshArgv } from "./ssh";

/**
 * Running warden on a host over ssh. Failures are coded claim-error strings (`HOST_UNREACHABLE: …`), so
 * `reportClaimFailure` prints them with their hint and exit code like any claim failure.
 */

export type RunOnHostOptions = { trustNew?: boolean; timeoutMs?: number; onLine?: (line: string) => void };

/** The host named `name`, or `HOST_UNKNOWN`. */
export function lookupHost(ctx: CommandContext, name: string): Result<HostRecord> {
	const host = getHost(ctx.store(), name);
	return host ? ok(host) : err(claimError({ code: "HOST_UNKNOWN" }, `no host named ${name}`));
}

/** The argv that runs `args` with the host's warden. */
export function wardenArgv(host: HostRecord, args: readonly string[]): string[] {
	return [host.wardenPath ?? "warden", ...args];
}

function lastLines(text: string, n = 3): string {
	return text.trim().split("\n").slice(-n).join(" | ");
}

/** `cmd` on the host. ssh's own failure (exit 255) is `HOST_AUTH` / `HOST_UNREACHABLE`; any other exit is the result. */
export async function runOnHost(
	ctx: CommandContext,
	host: HostRecord,
	cmd: readonly string[],
	opts: RunOnHostOptions = {}
): Promise<Result<ExecResult>> {
	const home = wardenHome(ctx.env);
	mkdirSync(hostControlDir(home), { recursive: true, mode: 0o700 });
	const argv = sshArgv(host, cmd, { home, ...(opts.trustNew ? { trustNew: true } : {}) });
	const result = await ctx.exec(argv, {
		timeoutMs: opts.timeoutMs ?? 60_000,
		...(opts.onLine ? { onLine: opts.onLine } : {}),
	});
	const failure = classifySshFailure(result.exitCode, result.stderr);
	if (failure !== undefined) {
		const why = lastLines(result.stderr) || `ssh exited ${result.exitCode}`;
		return err(claimError({ code: failure }, `${host.name}: ${why}`));
	}
	return ok(result);
}

/** A `--json` command's stdout: the whole document, else its last line (a JSON line after other output). */
export function parseJsonOutput(stdout: string): unknown {
	for (const candidate of [stdout.trim(), stdout.trim().split("\n").at(-1) ?? ""]) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try the next
		}
	}
	return undefined;
}

/** `warden <args…> --json` on the host, its stdout parsed; a non-zero exit is the remote error message (and code). */
export async function wardenJson(
	ctx: CommandContext,
	host: HostRecord,
	args: readonly string[],
	opts: RunOnHostOptions = {}
): Promise<Result<{ exitCode: number; json: unknown; stderr: string }>> {
	const ran = await runOnHost(ctx, host, wardenArgv(host, args), opts);
	if (!ran.success) return ran;
	const { exitCode, stdout, stderr } = ran.data;
	const json = parseJsonOutput(stdout);
	if (json === undefined) {
		const why = exitCode === 127 ? "warden is not installed there (warden host setup)" : lastLines(stderr || stdout);
		return err(`${host.name}: \`warden ${args[0] ?? ""}\` exited ${exitCode}: ${why}`);
	}
	return ok({ exitCode, json, stderr });
}

/** A `--json` failure envelope's message and code, if `json` is one. */
export function remoteFailure(json: unknown): { message: string; code?: string } | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const error: unknown = Reflect.get(json, "error");
	if (typeof error !== "object" || error === null) return undefined;
	const message: unknown = Reflect.get(error, "message");
	const code: unknown = Reflect.get(error, "code");
	return {
		message: typeof message === "string" ? message : "failed",
		...(typeof code === "string" ? { code } : {}),
	};
}

/** The host's warden version (`warden version --json`), or `HOST_VERSION_SKEW` when it is not this one's. */
export async function hostVersion(
	ctx: CommandContext,
	host: HostRecord,
	opts: RunOnHostOptions & { allowSkew?: boolean } = {}
): Promise<Result<string>> {
	const ran = await wardenJson(ctx, host, ["version", "--json"], opts);
	if (!ran.success) return ran;
	const version: unknown =
		typeof ran.data.json === "object" && ran.data.json !== null ? Reflect.get(ran.data.json, "version") : undefined;
	if (typeof version !== "string") return err(`${host.name}: \`warden version --json\` gave no version`);
	const mine = currentBuild().version;
	if (!opts.allowSkew && version !== mine) {
		return err(
			claimError({ code: "HOST_VERSION_SKEW" }, `${host.name} runs warden ${version}, this laptop runs ${mine}`)
		);
	}
	return ok(version);
}
