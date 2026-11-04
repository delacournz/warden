import { getGrant, HOST_OWNER_ENV } from "@delacour/warden-core/hosts/registry";
import { sameOwner } from "@delacour/warden-core/types";
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

async function serve(ctx: CommandContext, deps: HostServeDeps, opts: { key?: string }): Promise<number> {
	if (opts.key === undefined) {
		reportError(ctx, SCOPE, "--key is required");
		return 1;
	}
	const grant = getGrant(ctx.store(), opts.key);
	if (grant === undefined) {
		reportError(ctx, SCOPE, `key ${opts.key} is not granted on this host (warden host grant)`);
		return EXIT_REFUSED;
	}
	const checked = checkHostCommand(ctx.env.SSH_ORIGINAL_COMMAND ?? "");
	if (!checked.success) {
		reportError(ctx, SCOPE, checked.error);
		return EXIT_REFUSED;
	}
	const owner = { kind: "host", machineId: grant.machineId, user: grant.user } as const;
	const { name } = checked.data;
	const argv = [...checked.data.argv];
	if (name === "release" || name === "heartbeat") {
		const foreign = foreignLeaseIds(ctx, argv.slice(1), owner);
		if (foreign.length > 0) {
			reportError(ctx, SCOPE, `refused: ${foreign.join(" ")} is held by another owner on this host`);
			return EXIT_REFUSED;
		}
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
			cmd.option("--key <fingerprint>").action(async (opts) => done(await serve(ctx, deps, opts)));
		},
	});
}

export const hostServeCommand = createHostServeCommand();
