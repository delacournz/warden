import { parseArgs } from "node:util";
import { DEFAULT_TTL_MS } from "@warden/core/config.defaults";
import { formatDuration, parseDuration } from "@warden/core/duration";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { detectOwner, type OwnerContext, readGitInfo } from "@warden/core/owner";
import {
	claimPorts,
	DEFAULT_PORT_SPAN,
	isPortFree,
	listPortLeases,
	type PortReleaseSelector,
	parsePortSpec,
	releasePorts,
} from "@warden/core/ports";
import type { Lease, Owner } from "@warden/core/types";
import { describeOwner, ownerLocation } from "@warden/core/types";
import type { Result } from "@warden/types/result";
import { err, ok } from "@warden/types/result";
import type { Command, CommandContext } from "../context";
import { emit, formatTable } from "../output";

const DEFAULT_FROM = 8091;

const USAGE = [
	"usage:",
	`  warden port claim [--from ${DEFAULT_FROM}] [--span ${DEFAULT_PORT_SPAN}] [--count 1] [--ttl 30m] [--label x] [--json]`,
	"  warden port release <port…> | --lease <id…> | --mine [--force] [--json]",
	"  warden port ls [--json]",
].join("\n");

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

function usageError(ctx: CommandContext, message: string): number {
	ctx.err(`warden port: ${message}\n\n${USAGE}`);
	return 1;
}

type ClaimFlags = { from: number; span: number; count: number; ttlMs: number; label?: string; json: boolean };

function parseClaimFlags(args: string[]): Result<ClaimFlags> {
	const { values } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			span: { type: "string" },
			count: { type: "string" },
			ttl: { type: "string" },
			label: { type: "string" },
			json: { type: "boolean", default: false },
		},
		strict: true,
	});
	const from = values.from ?? String(DEFAULT_FROM);
	const range = parsePortSpec(values.span === undefined ? from : `${from}:${values.span}`);
	if (!range.success) return range;
	const count = parseCount(values.count, "count", 1);
	if (!count.success) return count;
	const ttl = values.ttl === undefined ? ok(DEFAULT_TTL_MS) : parseDuration(values.ttl);
	if (!ttl.success) return ttl;
	const flags: ClaimFlags = { ...range.data, count: count.data, ttlMs: ttl.data, json: values.json };
	if (values.label !== undefined) flags.label = values.label;
	return ok(flags);
}

async function claim(ctx: CommandContext, args: string[]): Promise<number> {
	const flags = parseClaimFlags(args);
	if (!flags.success) return usageError(ctx, flags.error);
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
	if (!res.success) {
		ctx.err(`warden port claim: ${res.error}`);
		return 1;
	}
	emit(ctx, flags.data.json, res.data, res.data.map((l) => String(portOf(l))).join("\n"));
	return 0;
}

type ReleaseFlags = { selector: PortReleaseSelector; force: boolean; json: boolean };

function parseReleaseFlags(args: string[], owner: () => Owner): Result<ReleaseFlags> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lease: { type: "string", multiple: true },
			mine: { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
		strict: true,
	});
	const leaseIds = values.lease ?? [];
	const modes = [positionals.length > 0, leaseIds.length > 0, values.mine].filter(Boolean).length;
	if (modes !== 1) return err("give exactly one of <port…>, --lease <id…>, --mine");
	const base = { force: values.force, json: values.json };
	if (values.mine) return ok({ ...base, selector: { by: "owner", owner: owner() } });
	if (leaseIds.length > 0) return ok({ ...base, selector: { by: "lease", ids: leaseIds } });
	const ports = positionals.map(Number);
	const bad = positionals.find((p) => {
		const n = Number(p);
		return !Number.isInteger(n) || n < 1 || n > 65_535;
	});
	if (bad !== undefined) return err(`invalid port "${bad}"`);
	return ok({ ...base, selector: { by: "port", ports } });
}

async function release(ctx: CommandContext, args: string[]): Promise<number> {
	let owner: Owner | undefined;
	const me = () => {
		owner ??= callerOwner(ctx);
		return owner;
	};
	const flags = parseReleaseFlags(args, me);
	if (!flags.success) return usageError(ctx, flags.error);
	const res = releasePorts(ctx.store(), flags.data.selector, flags.data.force ? {} : { onlyOwner: me() });
	const lines = res.released.map((l) => `released ${portOf(l)} (${l.id})`);
	emit(ctx, flags.data.json, res, lines.length > 0 ? lines.join("\n") : "nothing released");
	for (const l of res.denied) {
		ctx.err(`port ${portOf(l)} is leased by ${describeOwner(l.owner)} — use --force to release it`);
	}
	for (const m of res.missing) ctx.err(`no port lease for ${m}`);
	return res.denied.length > 0 || res.missing.length > 0 ? 1 : 0;
}

function lsRow(lease: Lease, now: number): string[] {
	return [
		String(portOf(lease)),
		isLeaseAlive(lease, now, processAlive) ? "alive" : "stale",
		describeOwner(lease.owner),
		ownerLocation(lease.owner) ?? "",
		lease.label ?? "",
		formatDuration(now - lease.acquiredAt),
		`${formatDuration(now - lease.heartbeatAt)} ago`,
		lease.id,
	];
}

async function ls(ctx: CommandContext, args: string[]): Promise<number> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } }, strict: true });
	const leases = listPortLeases(ctx.store());
	const now = ctx.now();
	const text =
		leases.length === 0
			? "no port leases"
			: formatTable(
					["PORT", "STATE", "OWNER", "WHERE", "LABEL", "AGE", "HEARTBEAT", "LEASE"],
					leases.map((l) => lsRow(l, now))
				);
	emit(ctx, values.json, leases, text);
	return 0;
}

const SUBCOMMANDS = new Map<string, (ctx: CommandContext, args: string[]) => Promise<number>>([
	["claim", claim],
	["release", release],
	["ls", ls],
]);

export const portCommand: Command = {
	name: "port",
	summary: "lease TCP ports from a range (bind-probed, never handed out twice)",
	usage: USAGE,
	run: async (ctx) => {
		const [sub, ...args] = ctx.argv;
		const handler = sub === undefined ? undefined : SUBCOMMANDS.get(sub);
		if (!handler) return usageError(ctx, sub === undefined ? "missing subcommand" : `unknown subcommand "${sub}"`);
		try {
			return await handler(ctx, args);
		} catch (error) {
			if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
				return usageError(ctx, error.message);
			}
			throw error;
		}
	},
};
