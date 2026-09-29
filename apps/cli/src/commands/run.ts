import { constants } from "node:os";
import { parseArgs } from "node:util";
import type { ClaimOutcome } from "@warden/core/claim";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@warden/core/config.defaults";
import { processAlive } from "@warden/core/liveness";
import { claimPorts, isPortFree, parsePortSpec } from "@warden/core/ports";
import type { Owner } from "@warden/core/types";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import {
	CLAIM_OPTIONS,
	CLAIM_USAGE_FLAGS,
	type ClaimFlags,
	claimedJson,
	claimWithFlags,
	parseClaimFlags,
	resolveOwner,
} from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";

const USAGE = `warden run ios|android ${CLAIM_USAGE_FLAGS} [--port FROM:SPAN …] -- <cmd…>`;

export type ForwardedSignal = "SIGINT" | "SIGTERM";

export type ChildHandle = { exited: Promise<number>; kill: (signal: ForwardedSignal) => void };

/** Side effects of `warden run`, injectable for tests. */
export type RunDeps = {
	/** pid recorded on the leases — the `warden run` process itself */
	pid: number;
	spawn: (cmd: string[], env: Record<string, string | undefined>) => ChildHandle;
	/** subscribe to a signal; returns unsubscribe */
	onSignal: (signal: ForwardedSignal, handler: () => void) => () => void;
	/** run `fn` every `ms`; returns stop */
	every: (ms: number, fn: () => void) => () => void;
	/** bind probe for `--port` ranges */
	isPortFree: (port: number) => Promise<boolean>;
};

/** A port leased for the child, exported as `WARDEN_PORT_<i>`. */
export type RunPort = { leaseId: string; port: number };

/** Lease one port per `--port FROM:SPAN` spec for `owner` (lease `pid`); all-or-nothing. */
export async function claimRunPorts(
	ctx: CommandContext,
	owner: Owner,
	specs: readonly string[],
	pid: number,
	isFree: (port: number) => Promise<boolean>
): AsyncResult<RunPort[]> {
	const store = ctx.store();
	const ports: RunPort[] = [];
	for (const spec of specs) {
		const range = parsePortSpec(spec);
		const claimed = range.success
			? await claimPorts(
					store,
					{ owner, ...range.data, ttlMs: DEFAULT_TTL_MS, pid, label: "warden run" },
					{ now: ctx.now, pidAlive: processAlive, isPortFree: isFree }
				)
			: range;
		if (!claimed.success) {
			store.deleteLeases(ports.map((p) => p.leaseId));
			return err(claimed.error);
		}
		for (const lease of claimed.data) {
			if (lease.resource.kind === "port") ports.push({ leaseId: lease.id, port: lease.resource.port });
		}
	}
	return ok(ports);
}

/** `[flags…, "--", cmd…]` → flags + command (everything after the first `--`). */
export function splitCommand(argv: readonly string[]): { flags: string[]; cmd: string[] } {
	const i = argv.indexOf("--");
	return i === -1 ? { flags: [...argv], cmd: [] } : { flags: argv.slice(0, i), cmd: argv.slice(i + 1) };
}

/** Env for the child: `WARDEN_UDIDS`, `WARDEN_UDID_<i>`, `WARDEN_LEASE_IDS`, `WARDEN_PORT(S)`. */
export function childEnv(
	base: Record<string, string | undefined>,
	outcome: ClaimOutcome,
	ports: RunPort[]
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...base };
	const udids = outcome.claimed.map((c) => c.device.id);
	env.WARDEN_UDIDS = udids.join(",");
	udids.forEach((udid, i) => {
		env[`WARDEN_UDID_${i}`] = udid;
	});
	env.WARDEN_LEASE_IDS = [...outcome.claimed.map((c) => c.lease.id), ...ports.map((p) => p.leaseId)].join(",");
	if (ports.length > 0) {
		env.WARDEN_PORTS = ports.map((p) => p.port).join(",");
		ports.forEach((p, i) => {
			env[`WARDEN_PORT_${i}`] = String(p.port);
		});
	}
	return env;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { ...CLAIM_OPTIONS, port: { type: "string", multiple: true } },
		allowPositionals: true,
		strict: true,
	});
}

type RunArgs = { cmd: string[]; flags: ClaimFlags; ports: string[]; json: boolean };

/** argv → validated run args (claim flags, `--port` specs, command after `--`). */
export function parseRunArgs(argv: readonly string[]): Result<RunArgs> {
	const { flags: flagArgs, cmd } = splitCommand(argv);
	if (cmd.length === 0) return err("missing command after --");
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(flagArgs);
	} catch (error) {
		return err(error);
	}
	const flags = parseClaimFlags(parsed.positionals[0], parsed.values);
	if (!flags.success) return flags;
	return ok({ cmd, flags: flags.data, ports: parsed.values.port ?? [], json: parsed.values.json === true });
}

/** Spawn the child, heartbeat `leaseIds`, forward SIGINT/SIGTERM; always `release()` at the end. */
async function supervise(
	ctx: CommandContext,
	deps: RunDeps,
	cmd: string[],
	env: Record<string, string | undefined>,
	leaseIds: string[],
	release: () => void
): Promise<number> {
	let child: ChildHandle;
	try {
		child = deps.spawn(cmd, env);
	} catch (error) {
		release();
		ctx.err(`warden run: ${error instanceof Error ? error.message : String(error)}`);
		return 127;
	}
	const store = ctx.store();
	const stopHeartbeat = deps.every(HEARTBEAT_INTERVAL_MS, () => {
		store.heartbeat(leaseIds, ctx.now());
	});
	const unsubscribe = (["SIGINT", "SIGTERM"] as const).map((signal) => deps.onSignal(signal, () => child.kill(signal)));
	try {
		return await child.exited;
	} finally {
		stopHeartbeat();
		for (const off of unsubscribe) off();
		release();
	}
}

/** Claim → spawn child with leases in env → heartbeat → release on exit; exit code passthrough. */
export function createRunCommand(deps: RunDeps): Command {
	async function run(ctx: CommandContext): Promise<number> {
		const args = parseRunArgs(ctx.argv);
		if (!args.success) {
			ctx.err(`warden run: ${args.error}\n${USAGE}`);
			return 1;
		}
		const { cmd, flags, json } = args.data;
		const store = ctx.store();
		const owner = resolveOwner(ctx);
		const outcome = await claimWithFlags(ctx, owner, flags, deps.pid);
		if (!outcome.success) {
			ctx.err(`warden run: ${outcome.error}`);
			return 1;
		}
		const deviceLeaseIds = outcome.data.claimed.map((c) => c.lease.id);
		const ports = await claimRunPorts(ctx, owner, args.data.ports, deps.pid, deps.isPortFree);
		if (!ports.success) {
			store.deleteLeases(deviceLeaseIds);
			ctx.err(`warden run: ${ports.error}`);
			return 1;
		}
		const leaseIds = [...deviceLeaseIds, ...ports.data.map((p) => p.leaseId)];
		const release = () => {
			store.deleteLeases(leaseIds);
			const now = ctx.now();
			for (const c of outcome.data.claimed) store.touchDevice(c.device.platform, c.device.id, now);
		};

		const summary = { leases: claimedJson(outcome.data), ports: ports.data, cmd };
		if (json) emit(ctx, true, summary, "");
		else ctx.err(`warden run: leased ${summary.leases.map((l) => `${l.udid} (${l.leaseId})`).join(", ")}`);
		return supervise(ctx, deps, cmd, childEnv(ctx.env, outcome.data, ports.data), leaseIds, release);
	}

	return {
		name: "run",
		summary: "claim devices, run a command with WARDEN_UDIDS set, release on exit",
		usage: USAGE,
		run,
	};
}

function signalNumber(signal: string | null | undefined): number {
	if (!signal) return 0;
	const n = (constants.signals as Record<string, number | undefined>)[signal];
	return n ?? 0;
}

export const defaultRunDeps: RunDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, env) {
		const proc = Bun.spawn(cmd, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		return {
			exited: proc.exited.then((code) => (proc.signalCode ? 128 + signalNumber(proc.signalCode) : code)),
			kill: (signal) => proc.kill(signal),
		};
	},
	onSignal(signal, handler) {
		process.on(signal, handler);
		return () => {
			process.off(signal, handler);
		};
	},
	every(ms, fn) {
		const timer = setInterval(fn, ms);
		return () => clearInterval(timer);
	},
};

export const runCommand: Command = createRunCommand(defaultRunDeps);
