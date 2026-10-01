import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { detectOwner, type OwnerContext, readGitInfo } from "@delacour/warden-core/owner";
import {
	claimPorts,
	DEFAULT_PORT_SPAN,
	isPortFree,
	listPortLeases,
	type PortReleaseSelector,
	parsePortSpec,
	releasePorts,
} from "@delacour/warden-core/ports";
import type { Lease, Owner } from "@delacour/warden-core/types";
import { describeOwner, ownerLocation } from "@delacour/warden-core/types";
import type { Result } from "@delacour/warden-types/result";
import { err, ok } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";

const DEFAULT_FROM = 8091;

/** The caller: agent session (WARDEN_SESSION_ID / CLAUDE_* env), CI, or the invoking shell. */
function callerOwner(ctx: CommandContext): Owner {
	const input: OwnerContext = { env: ctx.env, pid: process.pid, ppid: process.ppid, cwd: ctx.cwd };
	const git = readGitInfo(ctx.cwd);
	if (git) input.git = git;
	return detectOwner(input);
}

function portOf(lease: Lease): number | undefined {
	return lease.resource.kind === "port" ? lease.resource.port : undefined;
}

function parseCount(raw: string | undefined, name: string, fallback: number): Result<number> {
	if (raw === undefined) return ok(fallback);
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? ok(n) : err(`invalid --${name} "${raw}" (must be an integer ≥ 1)`);
}

function fail(ctx: CommandContext, sub: string, message: string): number {
	ctx.err(ctx.ui.color.red(`warden port ${sub}: ${message}`));
	return 1;
}

type PortClaimOpts = { from?: string; span?: string; count?: string; ttl?: string; label?: string; json?: true };

type PortClaim = { from: number; span: number; count: number; ttlMs: number; label?: string };

function parsePortClaim(opts: PortClaimOpts): Result<PortClaim> {
	const from = opts.from ?? String(DEFAULT_FROM);
	const range = parsePortSpec(opts.span === undefined ? from : `${from}:${opts.span}`);
	if (!range.success) return range;
	const count = parseCount(opts.count, "count", 1);
	if (!count.success) return count;
	const ttl = opts.ttl === undefined ? ok(DEFAULT_TTL_MS) : parseDuration(opts.ttl);
	if (!ttl.success) return ttl;
	const flags: PortClaim = { ...range.data, count: count.data, ttlMs: ttl.data };
	if (opts.label !== undefined) flags.label = opts.label;
	return ok(flags);
}

/** Lease free ports; stdout = one port per line (script-friendly: `PORT=$(warden port claim)`). */
async function claim(ctx: CommandContext, opts: PortClaimOpts): Promise<number> {
	const flags = parsePortClaim(opts);
	if (!flags.success) return fail(ctx, "claim", flags.error);
	const owner = callerOwner(ctx);
	const res = await claimPorts(
		ctx.store(),
		{
			owner,
			from: flags.data.from,
			span: flags.data.span,
			count: flags.data.count,
			ttlMs: flags.data.ttlMs,
			...(flags.data.label !== undefined ? { label: flags.data.label } : {}),
			...(owner.kind === "user" ? { pid: owner.pid } : {}),
		},
		{ now: ctx.now, pidAlive: processAlive, isPortFree: (port) => isPortFree(port) }
	);
	if (!res.success) return fail(ctx, "claim", res.error);
	emit(ctx, opts.json === true, res.data, res.data.map((l) => String(portOf(l))).join("\n"));
	return 0;
}

type PortReleaseOpts = { lease?: string[]; mine?: true; force?: true; json?: true };

function releaseSelector(ports: string[], opts: PortReleaseOpts, owner: () => Owner): Result<PortReleaseSelector> {
	const leaseIds = opts.lease ?? [];
	const modes = [ports.length > 0, leaseIds.length > 0, opts.mine === true].filter(Boolean).length;
	if (modes !== 1) return err("give exactly one of <port…>, --lease <id…>, --mine");
	if (opts.mine) return ok({ by: "owner", owner: owner() });
	if (leaseIds.length > 0) return ok({ by: "lease", ids: leaseIds });
	const bad = ports.find((p) => {
		const n = Number(p);
		return !Number.isInteger(n) || n < 1 || n > 65_535;
	});
	if (bad !== undefined) return err(`invalid port "${bad}"`);
	return ok({ by: "port", ports: ports.map(Number) });
}

async function release(ctx: CommandContext, ports: string[], opts: PortReleaseOpts): Promise<number> {
	const { color } = ctx.ui;
	let owner: Owner | undefined;
	const me = () => {
		owner ??= callerOwner(ctx);
		return owner;
	};
	const selector = releaseSelector(ports, opts, me);
	if (!selector.success) return fail(ctx, "release", selector.error);
	const res = releasePorts(ctx.store(), selector.data, opts.force ? {} : { onlyOwner: me() });
	const lines = res.released.map((l) => color.green(`released ${portOf(l)} (${l.id})`));
	emit(ctx, opts.json === true, res, lines.length > 0 ? lines.join("\n") : color.dim("nothing released"));
	for (const l of res.denied) {
		ctx.err(color.yellow(`port ${portOf(l)} is leased by ${describeOwner(l.owner)} — use --force to release it`));
	}
	for (const m of res.missing) ctx.err(color.red(`no port lease for ${m}`));
	return res.denied.length > 0 || res.missing.length > 0 ? 1 : 0;
}

function lsRow(ctx: CommandContext, lease: Lease, now: number): string[] {
	const { color } = ctx.ui;
	const alive = isLeaseAlive(lease, now, processAlive);
	return [
		color.bold(String(portOf(lease))),
		alive ? color.green("alive") : color.yellow("stale"),
		describeOwner(lease.owner),
		ownerLocation(lease.owner) ?? "",
		lease.label ?? "",
		formatDuration(now - lease.acquiredAt),
		`${formatDuration(now - lease.heartbeatAt)} ago`,
		color.dim(lease.id),
	];
}

function ls(ctx: CommandContext, json: boolean): number {
	const { color } = ctx.ui;
	const leases = listPortLeases(ctx.store());
	const now = ctx.now();
	const text =
		leases.length === 0
			? color.dim("no port leases")
			: formatTable(
					["PORT", "STATE", "OWNER", "WHERE", "LABEL", "AGE", "HEARTBEAT", "LEASE"],
					leases.map((l) => lsRow(ctx, l, now)),
					color
				);
	emit(ctx, json, leases, text);
	return 0;
}

export const portCommand = defineCommand({
	name: "port",
	summary: "lease TCP ports from a range (bind-probed, never handed out twice)",
	register: (cmd, ctx, done) => {
		cmd
			.command("claim")
			.description("lease free port(s) from FROM..FROM+SPAN; prints one port per line")
			.option("--from <port>", `first port of the range (default ${DEFAULT_FROM})`)
			.option("--span <n>", `range size (default ${DEFAULT_PORT_SPAN})`)
			.option("--count <n>", "how many ports (default 1)")
			.option("--ttl <duration>", "lease TTL without heartbeat (default 30m)")
			.option("--label <label>", "label shown in `warden port ls`")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await claim(ctx, opts)));
		cmd
			.command("release")
			.description("release port leases: <port…> | --lease <id…> | --mine (own leases only unless --force)")
			.argument("[ports...]", "ports to release")
			.option("--lease <id...>", "release these lease ids")
			.option("--mine", "release all of your port leases")
			.option("--force", "release leases held by someone else")
			.option("--json", "machine-readable output")
			.action(async (ports, opts) => done(await release(ctx, ports, opts)));
		cmd
			.command("ls")
			.description("list port leases")
			.option("--json", "machine-readable output")
			.action((opts) => done(ls(ctx, opts.json === true)));
	},
});
