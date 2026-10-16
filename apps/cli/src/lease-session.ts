import { constants } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import type { EnsureResult } from "@delacour/warden-core/builds/resolve";
import type { ClaimOutcome } from "@delacour/warden-core/claim";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@delacour/warden-core/config.defaults";
import { processAlive } from "@delacour/warden-core/liveness";
import { claimPorts, parsePortSpec } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type ClaimFlags, claimWithFlags } from "./claim-flags";
import { defaultAppDeps, type EnsureOptions, ensurePreparedApp, type PreparedApp, prepareApp } from "./commands/app";
import type { CommandContext } from "./context";
import { releaseDevices } from "./device-lease";
import { installModeOption, legacyCleanOption, parseInstallFlags, RESET_KEYCHAIN_HELP } from "./install-flags";
import type { Spinner } from "./ui";

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
			await releaseDevices(
				ctx,
				ports.map((p) => p.leaseId),
				{ touch: false }
			);
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

/** `WARDEN_HEADLESS=1` in a child env when the run is headless; removed otherwise, so children see the run's own value. */
export function setHeadlessEnv(env: Record<string, string | undefined>, headless: boolean): void {
	if (headless) env.WARDEN_HEADLESS = "1";
	else delete env.WARDEN_HEADLESS;
}

/** `--app` family option values shared by `run` and `batch`. */
export type AppFlagValues = {
	app?: true;
	/** `--install-mode` */
	installMode?: InstallMode;
	/** `--reset-keychain` */
	resetKeychain?: true;
	/** `--clean`: deprecated alias of `--install-mode reinstall` */
	clean?: true;
	project?: string;
	bundleId?: string;
	/** `--variant <name>`: a `projects[].variants` build */
	variant?: string;
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
		.addOption(installModeOption("--app: "))
		.option("--reset-keychain", RESET_KEYCHAIN_HELP)
		.addOption(legacyCleanOption())
		.option("--project <dir>", "--app: project directory (default: cwd)")
		.option("--bundle-id <id>", "--app: override the bundle id / package")
		.option("--variant <name>", "--app: install this projects[].variants build (dev, e2e…)")
		.option("--no-eas", "--app: don't download EAS builds")
		.option("--no-build", "--app: don't build locally on a cache miss");
}

/** `--app …` → ensure options (undefined without `--app`); the sub-flags need `--app`. */
export function parseAppFlags(opts: AppFlagValues): Result<EnsureOptions | undefined> {
	const install = parseInstallFlags(opts);
	if (!install.success) return install;
	if (opts.app) {
		return ok({
			eas: opts.eas,
			build: opts.build,
			...install.data,
			...(opts.project !== undefined ? { project: opts.project } : {}),
			...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
			...(opts.variant !== undefined ? { variant: opts.variant } : {}),
		});
	}
	const sub = opts.project ?? opts.bundleId ?? opts.variant;
	if (sub !== undefined || !opts.eas || !opts.build || install.data.installMode !== undefined) {
		return err(
			"--project / --no-eas / --no-build / --bundle-id / --variant / --install-mode / --reset-keychain / --clean need --app"
		);
	}
	return ok(undefined);
}

/**
 * What to lease: devices (claim flags), `--port` specs and optionally the app on each device.
 * `legFlags` (the device legs of an e2e suite) are claimed instead of `flags`, one claim each, in order.
 */
export type LeaseArgs = {
	flags: ClaimFlags;
	legFlags?: readonly ClaimFlags[];
	ports: string[];
	app?: EnsureOptions;
	/** the ports are leased (before the device claim, which can boot simulators for a while) */
	onPorts?: (ports: RunPort[]) => void;
	/** the devices + ports are held (before `--app` installs, which can take minutes) */
	onLeased?: (outcome: ClaimOutcome) => void;
	/** checked before each device claim and before the installs: true → everything is released, `interrupted` */
	aborted?: () => boolean;
};

/** The error of a claim the caller gave up on (`aborted`) — nothing to add to it. */
export const INTERRUPTED = "interrupted";

/** `--app`: ensure the app on every claimed device in parallel (waits for all, then reports the first failure); exports `WARDEN_APP_PATH` / `WARDEN_APP_HASH` into `env`. */
async function ensureSessionApp(
	ctx: CommandContext,
	ensure: RunEnsureApp,
	owner: Owner,
	outcome: ClaimOutcome,
	opts: EnsureOptions,
	env: Record<string, string | undefined>,
	name: string
): AsyncResult<void> {
	const results = await Promise.all(
		outcome.claimed.map((c) => ensure(ctx, owner, c.device.platform, c.device.id, opts))
	);
	for (const [i, c] of outcome.claimed.entries()) {
		const res = results[i];
		if (!res) continue;
		if (!res.success) return err(`app on ${c.device.id}: ${res.error}`);
		ctx.err(`warden ${name}: app ${res.data.source} on ${c.device.id} [${res.data.hash}]`);
		if (res.data.appPath) env.WARDEN_APP_PATH = res.data.appPath;
		env.WARDEN_APP_HASH = res.data.hash;
	}
	return ok(undefined);
}

export type LeaseSession = {
	/** every claimed device, leg after leg */
	outcome: ClaimOutcome;
	/** the devices of each claim (`legFlags`, else the one claim), in order */
	claims: ClaimOutcome[];
	ports: RunPort[];
	env: Record<string, string | undefined>;
	leaseIds: string[];
	/** delete every lease and mark the devices used now */
	release: () => Promise<void>;
};

/** The two halves of an ensure, injectable for tests: the device-independent prepare and the per-device install. */
export type SessionAppDeps = {
	prepare: (ctx: CommandContext, opts: EnsureOptions, platform: Platform) => AsyncResult<PreparedApp>;
	install: (
		ctx: CommandContext,
		owner: Owner,
		platform: Platform,
		deviceId: string,
		opts: EnsureOptions,
		app: PreparedApp
	) => AsyncResult<EnsureResult>;
};

const defaultSessionAppDeps: SessionAppDeps = {
	prepare: prepareApp,
	install: (ctx, owner, platform, deviceId, opts, app) =>
		ensurePreparedApp(ctx, defaultAppDeps, owner, platform, deviceId, opts, app),
};

/** One session's app: `warm` starts the fingerprint early, `ensure` installs on one device once it is in. */
export type SessionApp = {
	/** load + fingerprint the project for `platform` now (idempotent); nothing depends on a device yet */
	warm: (ctx: CommandContext, opts: EnsureOptions, platform: Platform) => void;
	ensure: RunEnsureApp;
};

/**
 * The default `ensureApp` of one session: the project is loaded and fingerprinted once per platform
 * (started by `warm` as soon as the ports are leased, so it overlaps the device boot), then installed
 * on each device (N devices used to mean N fingerprint runs).
 */
export function sessionEnsureApp(deps: SessionAppDeps = defaultSessionAppDeps): SessionApp {
	const prepared = new Map<Platform, AsyncResult<PreparedApp>>();
	const prepare = (ctx: CommandContext, opts: EnsureOptions, platform: Platform): AsyncResult<PreparedApp> => {
		const pending = prepared.get(platform) ?? deps.prepare(ctx, opts, platform);
		prepared.set(platform, pending);
		return pending;
	};
	return {
		warm: (ctx, opts, platform) => {
			// a throw surfaces where `ensure` awaits the same promise; nothing must trip on it before that
			prepare(ctx, opts, platform).catch(() => undefined);
		},
		ensure: async (ctx, owner, platform, deviceId, opts) => {
			const app = await prepare(ctx, opts, platform);
			if (!app.success) return app;
			return deps.install(ctx, owner, platform, deviceId, opts, app.data);
		},
	};
}

/** With `--app` and the default ensure: fingerprint every leg's platform now — it needs no device, the simulators boot meanwhile. */
function warmSessionApp(
	ctx: CommandContext,
	deps: Pick<LeaseSessionDeps, "ensureApp">,
	args: LeaseArgs
): SessionApp | undefined {
	if (!args.app || deps.ensureApp !== undefined) return undefined;
	const app = sessionEnsureApp();
	for (const platform of new Set((args.legFlags ?? [args.flags]).map((f) => f.request.platform)))
		app.warm(ctx, args.app, platform);
	return app;
}

/**
 * One claim per leg (else the one `flags` claim); a failed or aborted leg releases the earlier ones.
 * `aborted` is checked before each leg: a claim can boot simulators for a while, and the caller may
 * have lost its reason to continue (a Metro that failed, a signal) in the meantime.
 */
async function claimLegs(ctx: CommandContext, owner: Owner, args: LeaseArgs, pid: number): AsyncResult<ClaimOutcome[]> {
	const claims: ClaimOutcome[] = [];
	const releaseClaimed = () =>
		releaseDevices(
			ctx,
			claims.flatMap((c) => c.claimed.map((d) => d.lease.id)),
			{ touch: false }
		);
	for (const flags of args.legFlags ?? [args.flags]) {
		if (args.aborted?.()) {
			await releaseClaimed();
			return err(INTERRUPTED);
		}
		const outcome = await claimWithFlags(ctx, owner, flags, pid);
		if (!outcome.success) {
			await releaseClaimed();
			return outcome;
		}
		claims.push(outcome.data);
	}
	return ok(claims);
}

/**
 * Lease the ports, claim the devices and (with `--app`) ensure the app; on any failure nothing stays
 * leased. The ports come first (a bind probe, cheap) so `onPorts` can start the run's Metro while the
 * devices boot and the app installs. Port leases carry `--label` too (default `warden <name>`).
 */
export async function claimAll(
	ctx: CommandContext,
	deps: Pick<LeaseSessionDeps, "pid" | "isPortFree" | "ensureApp">,
	owner: Owner,
	args: LeaseArgs,
	name = "run"
): AsyncResult<LeaseSession> {
	const label = args.flags.label ?? `warden ${name}`;
	const ports = await claimRunPorts(ctx, owner, args.ports, deps.pid, deps.isPortFree, label);
	if (!ports.success) return ports;
	const portLeaseIds = ports.data.map((p) => p.leaseId);
	const releasePorts = () => releaseDevices(ctx, portLeaseIds, { touch: false });
	args.onPorts?.(ports.data);
	const sessionApp = warmSessionApp(ctx, deps, args);
	if (args.aborted?.()) {
		await releasePorts();
		return err(INTERRUPTED);
	}
	const claims = await claimLegs(ctx, owner, args, deps.pid);
	if (!claims.success) {
		await releasePorts();
		return claims;
	}
	const outcome: ClaimOutcome = {
		claimed: claims.data.flatMap((c) => c.claimed),
		reclaimed: claims.data.flatMap((c) => c.reclaimed),
	};
	const leaseIds = [...outcome.claimed.map((c) => c.lease.id), ...portLeaseIds];
	// a release leaves each iOS device's `warden-simd` resident: the next run on the device reuses it (no spawn, no
	// handshake) and its idle timeout reaps it otherwise; `--shutdown` / a device shutdown / a new lease owner stop it
	const release = async () => {
		await releaseDevices(ctx, leaseIds);
	};
	args.onLeased?.(outcome);
	const env = childEnv(ctx.env, outcome, ports.data);
	setHeadlessEnv(
		env,
		(args.legFlags ?? [args.flags]).some((f) => f.headless === true)
	);
	if (args.app) {
		if (args.aborted?.()) {
			await release();
			return err(INTERRUPTED);
		}
		const ensure = deps.ensureApp ?? sessionApp?.ensure ?? sessionEnsureApp().ensure;
		const app = await ensureSessionApp(ctx, ensure, owner, outcome, args.app, env, name);
		if (!app.success) {
			await release();
			return app;
		}
	}
	return ok({ outcome, claims: claims.data, ports: ports.data, env, release, leaseIds });
}

/** `leased <name>, …` — the claim spinner's line. */
export const leasedText = (outcome: ClaimOutcome) => `leased ${outcome.claimed.map((c) => c.device.name).join(", ")}`;

/**
 * With `--app` the installs run under the claim spinner: report the lease the moment it is held,
 * so the install lines that follow read as happening on leased devices.
 */
export function leasedProgress(
	spinner: Spinner,
	color: CommandContext["ui"]["color"],
	app: boolean
): ((outcome: ClaimOutcome) => void) | undefined {
	if (!app) return undefined;
	return (outcome) => {
		spinner.log(`${color.green("✔")} ${leasedText(outcome)}`);
		spinner.update(`installing the app on ${outcome.claimed.length} device(s)…`);
	};
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
