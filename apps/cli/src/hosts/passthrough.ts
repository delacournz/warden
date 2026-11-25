import { mkdirSync } from "node:fs";
import { claimError } from "@delacour/warden-core/claim-errors";
import { wardenHome } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { sameOwner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { reportClaimFailure } from "../physical-lock";
import { type HostLease, hostLeases } from "./claim";
import { lookupHost, wardenArgv } from "./remote";
import { classifySshFailure, hostControlDir, sshArgv } from "./ssh";

/**
 * `warden host run <name> -- <cmd…>` (`warden --host <name> <cmd…>`): one allowed warden command run on the host
 * (perf, golden ls/ensure, builds ls, capacity, queue, …), output and exit code as if it ran here. The host's
 * allowlist decides what may run; here only the caller's lease ids are swapped for the host's.
 */

/** `perf` subcommands that read sessions, not a device: no lease is added for them */
const PERF_SESSION_READS = new Set(["report", "query", "diff", "ls", "tools"]);

function leaseFlag(args: readonly string[]): { at: number; inline: boolean; id: string } | undefined {
	for (let at = 0; at < args.length; at++) {
		const word = args[at] ?? "";
		if (word === "--lease" && args[at + 1] !== undefined) return { at, inline: false, id: args[at + 1] ?? "" };
		if (word.startsWith("--lease=")) return { at, inline: true, id: word.slice("--lease=".length) };
	}
	return undefined;
}

function mine(ctx: CommandContext, owner: Owner): HostLease[] {
	return hostLeases(ctx.store().listLeasesByOwner(owner)).filter((l) => sameOwner(l.owner, owner));
}

/** `args` for the host: a local host lease id → the host's id; a device-bound `perf` gets the only lease there. */
export function passthroughArgs(
	ctx: CommandContext,
	owner: Owner,
	hostName: string,
	args: readonly string[]
): Result<string[]> {
	const out = [...args];
	const flag = leaseFlag(out);
	const leases = mine(ctx, owner);
	if (flag !== undefined) {
		const local = leases.find((l) => l.id === flag.id);
		if (local === undefined) return ok(out);
		if (local.resource.host !== hostName) return err(`${flag.id} is on ${local.resource.host}, not ${hostName}`);
		const remote = local.resource.remoteLeaseId;
		if (flag.inline) out[flag.at] = `--lease=${remote}`;
		else out[flag.at + 1] = remote;
		return ok(out);
	}
	if (out[0] !== "perf" || PERF_SESSION_READS.has(out[1] ?? "")) return ok(out);
	const there = leases.filter((l) => l.resource.host === hostName);
	const [only] = there;
	if (there.length === 1 && only !== undefined) return ok([...out, "--lease", only.resource.remoteLeaseId]);
	if (there.length === 0) return err(`no device of yours on ${hostName}: warden claim <platform> --host ${hostName}`);
	return err(`${there.length} devices of yours on ${hostName}: pass --lease <id> (warden ls --hosts)`);
}

export type PassthroughSpawn = (argv: readonly string[]) => Promise<{ exitCode: number; stderr: string }>;

/** stdin and stdout are the terminal's; stderr is shown as it comes and kept, to tell ssh's own failure apart. */
const spawnPassthrough: PassthroughSpawn = async (argv) => {
	const proc = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "pipe" });
	let stderr = "";
	const decoder = new TextDecoder();
	for await (const chunk of proc.stderr) {
		process.stderr.write(chunk);
		stderr += decoder.decode(chunk, { stream: true });
	}
	return { exitCode: await proc.exited, stderr };
};

export type PassthroughDeps = { spawn?: PassthroughSpawn; tty?: boolean; owner?: Owner };

/** Run `args` with the host's warden; returns its exit code (ssh's own failure: the `HOST_*` code's exit). */
export async function runPassthrough(
	ctx: CommandContext,
	hostName: string,
	args: readonly string[],
	deps: PassthroughDeps
): Promise<number> {
	const host = lookupHost(ctx, hostName);
	if (!host.success) return reportClaimFailure(ctx, "host run", host.error);
	const { resolveOwner } = await import("../claim-flags");
	const remoteArgs = passthroughArgs(ctx, deps.owner ?? resolveOwner(ctx), hostName, args);
	if (!remoteArgs.success) return reportClaimFailure(ctx, "host run", remoteArgs.error);
	const home = wardenHome(ctx.env);
	mkdirSync(hostControlDir(home), { recursive: true, mode: 0o700 });
	const argv = sshArgv(host.data, wardenArgv(host.data, remoteArgs.data), {
		home,
		...(deps.tty ? { forwards: ["-t"] } : {}),
	});
	const ran = await (deps.spawn ?? spawnPassthrough)(argv);
	const failure = classifySshFailure(ran.exitCode, ran.stderr);
	if (failure === undefined) return ran.exitCode;
	const why = ran.stderr.trim().split("\n").at(-1) || `ssh exited ${ran.exitCode}`;
	return reportClaimFailure(ctx, "host run", claimError({ code: failure }, `${hostName}: ${why}`));
}
