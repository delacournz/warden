import { getGrant, HOST_OWNER_ENV, parseHostOwner } from "@delacour/warden-core/hosts/registry";
import { type HostOwner, sameOwner } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { checkHostCommand } from "../hosts/allowlist";
import { reportError } from "../output";
import { selfCommand } from "../self-command";

/** Runs the allowed warden argv with stdio inherited; resolves its exit code. */
export type HostServeSpawn = (argv: readonly string[], env: Record<string, string | undefined>) => Promise<number>;

export type HostServeDeps = { spawn?: HostServeSpawn; self?: readonly string[] };

const SCOPE = "__host-serve";
const EXIT_REFUSED = 2;
/** a host lease outlives a lost laptop by at most this long (renewed every 30 s) */
const DEFAULT_REMOTE_TTL = "90s";

/** Env names that pick an owner (`detectOwner`): never passed on, so only the grant decides who runs. */
const OWNER_ENV = [
	"WARDEN_SESSION_ID",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_SESSION_ID",
	"CI",
	"GITHUB_ACTIONS",
	"SSH_ORIGINAL_COMMAND",
];

const bunSpawn: HostServeSpawn = async (argv, env) => {
	const proc = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
	return await proc.exited;
};

/** Lease ids among `words` that exist and belong to someone other than `owner`. */
function foreignLeaseIds(
	ctx: CommandContext,
	words: readonly string[],
	owner: Parameters<typeof sameOwner>[0]
): string[] {
	const store = ctx.store();
	return words.filter((w) => {
		if (w.startsWith("-")) return false;
		const lease = store.getLease(w);
		return lease !== undefined && !sameOwner(lease.owner, owner);
	});
}

/** `perf` subcommands that read a session, not a device: they need no lease */
const PERF_SESSION_READS = new Set(["report", "query", "diff", "ls", "tools"]);

/** Why `perf …` is refused: a device-bound subcommand must name the caller's own `--lease`. */
function perfRefusal(ctx: CommandContext, argv: readonly string[], owner: Parameters<typeof sameOwner>[0]) {
	if (PERF_SESSION_READS.has(argv[1] ?? "")) return undefined;
	const at = argv.indexOf("--lease");
	const id = at >= 0 ? argv[at + 1] : argv.find((w) => w.startsWith("--lease="))?.slice("--lease=".length);
	if (id === undefined) return `refused: \`perf ${argv[1]}\` needs --lease <your lease id> over warden host`;
	const lease = ctx.store().getLease(id);
	if (lease === undefined || !sameOwner(lease.owner, owner)) return `refused: ${id} is not your lease on this host`;
	return undefined;
}

/** Why the lease ids `argv` names are refused for `owner`: someone else's lease (release, heartbeat, perf). */
function leaseRefusal(
	ctx: CommandContext,
	name: string,
	argv: readonly string[],
	owner: Parameters<typeof sameOwner>[0]
): string | undefined {
	if (name === "perf") return perfRefusal(ctx, argv, owner);
	if (name !== "release" && name !== "heartbeat") return undefined;
	const foreign = foreignLeaseIds(ctx, argv.slice(1), owner);
	return foreign.length > 0 ? `refused: ${foreign.join(" ")} is held by another owner on this host` : undefined;
}

type ServeOpts = { key?: string; relayOwner?: string };

/**
 * Who the command runs as: the grant of the ssh key (`--key`, written into authorized_keys by `host grant`), or the
 * owner warden-api vouched for on a relayed channel (`--relay-owner`, passed only by `host serve --uplink`).
 */
type Refused = { message: string; exit: number };

const refuse = (message: string, exit: number): Result<HostOwner, Refused> => ({
	success: false,
	error: { message, exit },
});

function callerOwner(ctx: CommandContext, opts: ServeOpts): Result<HostOwner, Refused> {
	if (opts.relayOwner !== undefined) {
		const owner = opts.key === undefined ? parseHostOwner(opts.relayOwner) : undefined;
		return owner ? ok(owner) : refuse("--relay-owner: not a {machineId, user} owner", 1);
	}
	if (opts.key === undefined) return refuse("--key is required", 1);
	const grant = getGrant(ctx.store(), opts.key);
	if (grant === undefined) {
		return refuse(`key ${opts.key} is not granted on this host (warden host grant)`, EXIT_REFUSED);
	}
	return ok({ kind: "host", machineId: grant.machineId, user: grant.user });
}

async function serve(ctx: CommandContext, deps: HostServeDeps, opts: ServeOpts): Promise<number> {
	const who = callerOwner(ctx, opts);
	if (!who.success) {
		reportError(ctx, SCOPE, who.error.message);
		return who.error.exit;
	}
	const checked = checkHostCommand(ctx.env.SSH_ORIGINAL_COMMAND ?? "");
	if (!checked.success) {
		reportError(ctx, SCOPE, checked.error);
		return EXIT_REFUSED;
	}
	const owner = who.data;
	const { name } = checked.data;
	const argv = [...checked.data.argv];
	const refused = leaseRefusal(ctx, name, argv, owner);
	if (refused !== undefined) {
		reportError(ctx, SCOPE, refused);
		return EXIT_REFUSED;
	}
	if (name === "claim" && !argv.some((w) => w === "--ttl" || w.startsWith("--ttl="))) {
		argv.push("--ttl", ctx.env.WARDEN_REMOTE_TTL ?? DEFAULT_REMOTE_TTL);
	}
	const env: Record<string, string | undefined> = { ...ctx.env };
	for (const key of OWNER_ENV) delete env[key];
	env[HOST_OWNER_ENV] = JSON.stringify({ machineId: owner.machineId, user: owner.user });
	return (deps.spawn ?? bunSpawn)([...(deps.self ?? selfCommand()), ...argv], env);
}

/**
 * `warden __host-serve --key <fingerprint>`: the forced command a `warden host grant` writes into
 * `~/.ssh/authorized_keys`. It runs the one allowed warden command in `SSH_ORIGINAL_COMMAND` (`hosts/allowlist.ts`)
 * as the grant's host owner (`WARDEN_HOST_OWNER`, owner key `host:<machineId>`), stdio passed through. Exit 2 =
 * refused (no grant, a command or flag not allowed, another owner's lease); otherwise the command's own exit code.
 */
export function createHostServeCommand(deps: HostServeDeps = {}) {
	return defineCommand({
		name: "__host-serve",
		summary: "the forced command a warden host grant installs: runs one allowed warden command for a laptop (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd
				.option("--key <fingerprint>")
				.option("--relay-owner <json>")
				.action(async (opts) => done(await serve(ctx, deps, opts)));
		},
	});
}

export const hostServeCommand = createHostServeCommand();
