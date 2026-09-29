import { constants } from "node:os";
import type { EnsureResult } from "@warden/core/builds/resolve";
import type { ClaimOutcome } from "@warden/core/claim";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@warden/core/config.defaults";
import { processAlive } from "@warden/core/liveness";
import { claimPorts, isPortFree, parsePortSpec } from "@warden/core/ports";
import type { Owner, Platform } from "@warden/core/types";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlags,
	type ClaimFlagValues,
	claimedJson,
	claimWithFlags,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
} from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import { defaultAppDeps, type EnsureOptions, ensureAppFor } from "./app";

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
	/** `--app`: make sure the project's app is installed on a claimed device (default: `ensureAppFor`) */
	ensureApp?: RunEnsureApp;
};

export type RunEnsureApp = (
	ctx: CommandContext,
	owner: Owner,
	platform: Platform,
	deviceId: string,
	opts: EnsureOptions
) => AsyncResult<EnsureResult>;

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

/** Commander option values of `warden run` (claim options + `--port` / `--app` family). */
export type RunOpts = ClaimFlagValues & {
	json?: true;
	port: string[];
	app?: true;
	project?: string;
	bundleId?: string;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
};

type RunArgs = { flags: ClaimFlags; ports: string[]; json: boolean; app?: EnsureOptions };

/**
 * The child command is everything after the first `--` of the raw argv (commander drops the `--`
 * itself); the operands before it are the optional platform.
 */
export function splitOperands(
	argv: readonly string[],
	operands: readonly string[]
): Result<{ platformArg?: string; cmd: string[] }> {
	const { cmd } = splitCommand(argv);
	if (cmd.length === 0) return err("missing command after -- (warden run ios -- <cmd…>)");
	const before = operands.slice(0, Math.max(0, operands.length - cmd.length));
	if (before.length > 1) return err(`unexpected arguments before --: ${before.slice(1).join(" ")}`);
	const [platformArg] = before;
	return ok(platformArg === undefined ? { cmd } : { platformArg, cmd });
}

/** Validated run args from the resolved platform + option values. */
export function parseRunArgs(platform: Platform, opts: RunOpts): Result<RunArgs> {
	const flags = parseClaimFlags(platform, opts);
	if (!flags.success) return flags;
	const args: RunArgs = { flags: flags.data, ports: opts.port, json: opts.json === true };
	if (opts.app) {
		args.app = {
			eas: opts.eas,
			build: opts.build,
			...(opts.project !== undefined ? { project: opts.project } : {}),
			...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		};
	} else if (opts.project !== undefined || !opts.eas || !opts.build || opts.bundleId !== undefined) {
		return err("--project / --no-eas / --no-build / --bundle-id need --app");
	}
	return ok(args);
}

/** `--app`: ensure the app on every claimed device; exports `WARDEN_APP_PATH` / `WARDEN_APP_HASH` into `env`. */
async function ensureRunApp(
	ctx: CommandContext,
	ensure: RunEnsureApp,
	owner: Owner,
	outcome: ClaimOutcome,
	opts: EnsureOptions,
	env: Record<string, string | undefined>
): AsyncResult<void> {
	for (const c of outcome.claimed) {
		const res = await ensure(ctx, owner, c.device.platform, c.device.id, opts);
		if (!res.success) return err(`app on ${c.device.id}: ${res.error}`);
		ctx.err(`warden run: app ${res.data.source} on ${c.device.id} [${res.data.hash}]`);
		if (res.data.appPath) env.WARDEN_APP_PATH = res.data.appPath;
		env.WARDEN_APP_HASH = res.data.hash;
	}
	return ok(undefined);
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
		ctx.err(ctx.ui.color.red(`warden run: ${error instanceof Error ? error.message : String(error)}`));
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

type Claimed = { outcome: ClaimOutcome; ports: RunPort[]; env: Record<string, string | undefined> };

/** Claim devices + ports and (with `--app`) ensure the app; on any failure nothing stays leased. */
async function claimAll(
	ctx: CommandContext,
	deps: RunDeps,
	owner: Owner,
	args: RunArgs
): AsyncResult<Claimed & { release: () => void; leaseIds: string[] }> {
	const store = ctx.store();
	const outcome = await claimWithFlags(ctx, owner, args.flags, deps.pid);
	if (!outcome.success) return outcome;
	const deviceLeaseIds = outcome.data.claimed.map((c) => c.lease.id);
	const ports = await claimRunPorts(ctx, owner, args.ports, deps.pid, deps.isPortFree);
	if (!ports.success) {
		store.deleteLeases(deviceLeaseIds);
		return ports;
	}
	const leaseIds = [...deviceLeaseIds, ...ports.data.map((p) => p.leaseId)];
	const release = () => {
		store.deleteLeases(leaseIds);
		const now = ctx.now();
		for (const c of outcome.data.claimed) store.touchDevice(c.device.platform, c.device.id, now);
	};
	const env = childEnv(ctx.env, outcome.data, ports.data);
	if (args.app) {
		const app = await ensureRunApp(ctx, deps.ensureApp ?? defaultEnsureApp, owner, outcome.data, args.app, env);
		if (!app.success) {
			release();
			return app;
		}
	}
	return ok({ outcome: outcome.data, ports: ports.data, env, release, leaseIds });
}

/** Claim (under a spinner) → spawn child with leases in env → heartbeat → release on exit; exit code passthrough. */
async function run(ctx: CommandContext, deps: RunDeps, operands: readonly string[], opts: RunOpts): Promise<number> {
	const { color } = ctx.ui;
	const fail = (message: string) => {
		ctx.err(color.red(`warden run: ${message}`));
		return 1;
	};
	const target = splitOperands(ctx.argv, operands);
	if (!target.success) return fail(target.error);
	const platform = await resolvePlatform(ctx, target.data.platformArg);
	if (!platform.success) return fail(platform.error);
	const args = parseRunArgs(platform.data, opts);
	if (!args.success) return fail(args.error);
	const { cmd } = target.data;
	const owner = resolveOwner(ctx);
	maybeAutoGc(ctx);
	const { count, profile } = args.data.flags.request;
	const claimed = await withSpinner(
		ctx,
		`claiming ${count} ${profile} ${platform.data} device(s)…`,
		async (sctx, spinner) => {
			const result = await claimAll(sctx, deps, owner, args.data);
			if (result.success) spinner.succeed(`leased ${result.data.outcome.claimed.map((c) => c.device.name).join(", ")}`);
			else spinner.fail("claim failed");
			return result;
		}
	);
	if (!claimed.success) return fail(claimed.error);
	const { outcome, ports, env, release, leaseIds } = claimed.data;
	const summary = { leases: claimedJson(outcome), ports, cmd };
	if (args.data.json) emit(ctx, true, summary, "");
	else ctx.err(color.dim(`warden run: leased ${summary.leases.map((l) => `${l.udid} (${l.leaseId})`).join(", ")}`));
	return supervise(ctx, deps, cmd, env, leaseIds, release);
}

/** `warden run [platform] [claim options] [--port …] [--app …] -- <cmd…>` with injectable effects. */
export function createRunCommand(deps: RunDeps): Command {
	return defineCommand({
		name: "run",
		summary: "claim devices, run a command with WARDEN_UDIDS set, release on exit",
		register: (cmd, ctx, done) => {
			withClaimOptions(
				cmd
					.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
					.argument("[cmd...]", "the command to run, after --")
			)
				.option(
					"--port <from:span>",
					"lease a port from FROM..FROM+SPAN for the child (WARDEN_PORT_<i>); repeatable",
					(value: string, previous: string[]) => [...previous, value],
					[] as string[]
				)
				.option("--app", "install the project's app (fingerprint → cache → EAS → build) on each device first")
				.option("--project <dir>", "--app: project directory (default: cwd)")
				.option("--bundle-id <id>", "--app: override the bundle id / package")
				.option("--no-eas", "--app: don't download EAS builds")
				.option("--no-build", "--app: don't build locally on a cache miss")
				.addHelpText("after", "\nExample:\n  warden run ios --count 2 --port 8091:20 -- bun e2e")
				.action(async (platform, rest, opts) =>
					done(await run(ctx, deps, platform === undefined ? rest : [platform, ...rest], opts))
				);
		},
	});
}

function signalNumber(signal: string | null | undefined): number {
	if (!signal) return 0;
	const n = (constants.signals as Record<string, number | undefined>)[signal];
	return n ?? 0;
}

const defaultEnsureApp: RunEnsureApp = (ctx, owner, platform, deviceId, opts) =>
	ensureAppFor(ctx, defaultAppDeps, owner, platform, deviceId, opts);

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
