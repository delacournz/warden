import { constants } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import type { EnsureResult } from "@warden/core/builds/resolve";
import type { ClaimOutcome } from "@warden/core/claim";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@warden/core/config.defaults";
import { processAlive } from "@warden/core/liveness";
import { claimPorts, parsePortSpec } from "@warden/core/ports";
import type { Owner, Platform } from "@warden/core/types";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import { type ClaimFlags, claimWithFlags } from "./claim-flags";
import { defaultAppDeps, type EnsureOptions, ensureAppFor } from "./commands/app";
import type { CommandContext } from "./context";

/** Shared by `warden run` and `warden batch`: claim devices + ports, child env, heartbeat, release. */

export type ForwardedSignal = "SIGINT" | "SIGTERM";

export type ChildHandle = { exited: Promise<number>; kill: (signal: ForwardedSignal) => void };

export type RunEnsureApp = (
	ctx: CommandContext,
	owner: Owner,
	platform: Platform,
	deviceId: string,
	opts: EnsureOptions
) => AsyncResult<EnsureResult>;

/** Effects a lease session needs (a subset of `RunDeps` / `BatchDeps`). */
export type LeaseSessionDeps = {
	/** pid recorded on the leases — the warden process itself */
	pid: number;
	/** subscribe to a signal; returns unsubscribe */
	onSignal: (signal: ForwardedSignal, handler: () => void) => () => void;
	/** run `fn` every `ms`; returns stop */
	every: (ms: number, fn: () => void) => () => void;
	/** bind probe for `--port` ranges */
	isPortFree: (port: number) => Promise<boolean>;
	/** `--app`: make sure the project's app is installed on a claimed device (default: `ensureAppFor`) */
	ensureApp?: RunEnsureApp;
};

/** A port leased for the child, exported as `WARDEN_PORT_<i>`. */
export type RunPort = { leaseId: string; port: number };

/** Lease one port per `--port FROM:SPAN` spec for `owner` (lease `pid`); all-or-nothing. */
export async function claimRunPorts(
	ctx: CommandContext,
	owner: Owner,
	specs: readonly string[],
	pid: number,
	isFree: (port: number) => Promise<boolean>,
	label = "warden run"
): AsyncResult<RunPort[]> {
	const store = ctx.store();
	const ports: RunPort[] = [];
	for (const spec of specs) {
		const range = parsePortSpec(spec);
		const claimed = range.success
			? await claimPorts(
					store,
					{ owner, ...range.data, ttlMs: DEFAULT_TTL_MS, pid, label },
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

/**
 * The child command is everything after the first `--` of the raw argv (commander drops the `--`
 * itself); the operands before it are the optional platform.
 */
export function splitOperands(
	argv: readonly string[],
	operands: readonly string[],
	name = "run"
): Result<{ platformArg?: string; cmd: string[] }> {
	const { cmd } = splitCommand(argv);
	if (cmd.length === 0) return err(`missing command after -- (warden ${name} ios -- <cmd…>)`);
	const before = operands.slice(0, Math.max(0, operands.length - cmd.length));
	if (before.length > 1) return err(`unexpected arguments before --: ${before.slice(1).join(" ")}`);
	const [platformArg] = before;
	return ok(platformArg === undefined ? { cmd } : { platformArg, cmd });
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

/** `--app` family option values shared by `run` and `batch`. */
export type AppFlagValues = {
	app?: true;
	project?: string;
	bundleId?: string;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
};

/** `--port` / `--app` family options shared by `run` and `batch`. */
export function withLeaseOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
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
		.option("--no-build", "--app: don't build locally on a cache miss");
}

/** `--app …` → ensure options (undefined without `--app`); the sub-flags need `--app`. */
export function parseAppFlags(opts: AppFlagValues): Result<EnsureOptions | undefined> {
	if (opts.app) {
		return ok({
			eas: opts.eas,
			build: opts.build,
			...(opts.project !== undefined ? { project: opts.project } : {}),
			...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		});
	}
	if (opts.project !== undefined || !opts.eas || !opts.build || opts.bundleId !== undefined) {
		return err("--project / --no-eas / --no-build / --bundle-id need --app");
	}
	return ok(undefined);
}

/** What to lease: devices (claim flags), `--port` specs and optionally the app on each device. */
export type LeaseArgs = { flags: ClaimFlags; ports: string[]; app?: EnsureOptions };

/** `--app`: ensure the app on every claimed device; exports `WARDEN_APP_PATH` / `WARDEN_APP_HASH` into `env`. */
async function ensureSessionApp(
	ctx: CommandContext,
	ensure: RunEnsureApp,
	owner: Owner,
	outcome: ClaimOutcome,
	opts: EnsureOptions,
	env: Record<string, string | undefined>,
	name: string
): AsyncResult<void> {
	for (const c of outcome.claimed) {
		const res = await ensure(ctx, owner, c.device.platform, c.device.id, opts);
		if (!res.success) return err(`app on ${c.device.id}: ${res.error}`);
		ctx.err(`warden ${name}: app ${res.data.source} on ${c.device.id} [${res.data.hash}]`);
		if (res.data.appPath) env.WARDEN_APP_PATH = res.data.appPath;
		env.WARDEN_APP_HASH = res.data.hash;
	}
	return ok(undefined);
}

export type LeaseSession = {
	outcome: ClaimOutcome;
	ports: RunPort[];
	env: Record<string, string | undefined>;
	leaseIds: string[];
	/** delete every lease and mark the devices used now */
	release: () => void;
};

const defaultEnsureApp: RunEnsureApp = (ctx, owner, platform, deviceId, opts) =>
	ensureAppFor(ctx, defaultAppDeps, owner, platform, deviceId, opts);

/**
 * Claim devices + ports and (with `--app`) ensure the app; on any failure nothing stays leased.
 * Port leases carry `--label` too (default `warden <name>`).
 */
export async function claimAll(
	ctx: CommandContext,
	deps: Pick<LeaseSessionDeps, "pid" | "isPortFree" | "ensureApp">,
	owner: Owner,
	args: LeaseArgs,
	name = "run"
): AsyncResult<LeaseSession> {
	const store = ctx.store();
	const outcome = await claimWithFlags(ctx, owner, args.flags, deps.pid);
	if (!outcome.success) return outcome;
	const deviceLeaseIds = outcome.data.claimed.map((c) => c.lease.id);
	const label = args.flags.label ?? `warden ${name}`;
	const ports = await claimRunPorts(ctx, owner, args.ports, deps.pid, deps.isPortFree, label);
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
		const ensure = deps.ensureApp ?? defaultEnsureApp;
		const app = await ensureSessionApp(ctx, ensure, owner, outcome.data, args.app, env, name);
		if (!app.success) {
			release();
			return app;
		}
	}
	return ok({ outcome: outcome.data, ports: ports.data, env, release, leaseIds });
}

/**
 * Heartbeat `leaseIds` every `HEARTBEAT_INTERVAL_MS` and route SIGINT/SIGTERM to `onSignal`
 * until the returned stop function is called.
 */
export function holdLeases(
	ctx: CommandContext,
	deps: Pick<LeaseSessionDeps, "every" | "onSignal">,
	leaseIds: readonly string[],
	onSignal: (signal: ForwardedSignal) => void
): () => void {
	const store = ctx.store();
	const stopHeartbeat = deps.every(HEARTBEAT_INTERVAL_MS, () => {
		store.heartbeat([...leaseIds], ctx.now());
	});
	const unsubscribe = (["SIGINT", "SIGTERM"] as const).map((signal) => deps.onSignal(signal, () => onSignal(signal)));
	return () => {
		stopHeartbeat();
		for (const off of unsubscribe) off();
	};
}

function signalNumber(signal: string | null | undefined): number {
	if (!signal) return 0;
	const n = (constants.signals as Record<string, number | undefined>)[signal];
	return n ?? 0;
}

/** Shell-style exit code of a finished Bun subprocess: `128 + signal` when it was killed. */
export function exitCodeOf(proc: { signalCode: string | null }, code: number): number {
	return proc.signalCode ? 128 + signalNumber(proc.signalCode) : code;
}

/** Default `onSignal`: subscribe on `process`. */
export function processOnSignal(signal: ForwardedSignal, handler: () => void): () => void {
	process.on(signal, handler);
	return () => {
		process.off(signal, handler);
	};
}

/** Default `every`: `setInterval`. */
export function intervalEvery(ms: number, fn: () => void): () => void {
	const timer = setInterval(fn, ms);
	return () => clearInterval(timer);
}
