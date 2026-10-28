import { constants } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import type { KindApp } from "@delacour/warden-core/builds/ensure-kind";
import type { BuildKind } from "@delacour/warden-core/builds/kinds";
import type { AppPhase, EnsureResult } from "@delacour/warden-core/builds/resolve";
import { CLAIM_ABORTED, type ClaimOutcome } from "@delacour/warden-core/claim";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@delacour/warden-core/config.defaults";
import { processAlive } from "@delacour/warden-core/liveness";
import { claimPorts, parsePortSpec } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { phaseTracker } from "./app-phase";
import { selfCommand } from "./autogc";
import { type ClaimFlags, claimWithFlags } from "./claim-flags";
import { defaultAppDeps, type EnsureOptions, ensurePreparedApp, type PreparedApp, prepareApp } from "./commands/app";
import type { CommandContext } from "./context";
import { releaseDevices } from "./device-lease";
import {
	installModeOption,
	kindOption,
	legacyCleanOption,
	parseInstallFlags,
	RESET_KEYCHAIN_HELP,
} from "./install-flags";
import { reportError } from "./output";
import type { HideStart } from "./sim-windows";
import type { Spinner } from "./ui";

/** Shared by `warden run` and `warden batch`: claim devices + ports, child env, heartbeat, release. */

/** Signals a run forwards to its child and ends on: Ctrl-C, a kill, and the terminal going away. */
export type ForwardedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export const FORWARDED_SIGNALS: readonly ForwardedSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export type ChildHandle = { exited: Promise<number>; kill: (signal: ForwardedSignal) => void };

export type RunEnsureApp = (
	ctx: CommandContext,
	owner: Owner,
	platform: Platform,
	deviceId: string,
	opts: EnsureOptions
) => AsyncResult<EnsureResult & { kindApp?: KindApp }>;

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

/**
 * `WARDEN_AFTER_REBOOT` in a child env for a non-headless macOS run: the argv the e2e session runs after it rebooted a
 * sim whose HID connection was lost (`warden arrange --open <udid>`: reopen the sim's Device Hub window, tile again).
 * `packages/e2e` cannot import this app, so the seam is an env var holding a JSON argv, like `WARDEN_LAUNCH_ARGS`.
 * Headless runs get none (they never show windows); removed otherwise so children see the run's own value.
 */
export function setAfterRebootEnv(
	env: Record<string, string | undefined>,
	headless: boolean,
	self: readonly string[] = selfCommand(),
	os: NodeJS.Platform = process.platform
): void {
	if (headless || os !== "darwin") delete env.WARDEN_AFTER_REBOOT;
	else env.WARDEN_AFTER_REBOOT = JSON.stringify([...self, "arrange", "--open", "{udid}"]);
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
	/** `--kind <kind>`: a build kind (`simulator` = repacked) instead of the project's kind-less build */
	kind?: BuildKind;
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
			"lease a port from FROM..FROM+SPAN-1 (inclusive) for the child (WARDEN_PORT_<i>); repeatable",
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
		.addOption(kindOption("--app: "))
		.option("--no-eas", "--app: don't download EAS builds")
		.option("--no-build", "--app: don't build locally on a cache miss");
}

const kindWithVariant = (opts: Pick<AppFlagValues, "kind" | "variant">): boolean =>
	opts.kind !== undefined && opts.variant !== undefined;

/** `--app …` → ensure options (undefined without `--app`); the sub-flags need `--app`. */
export function parseAppFlags(opts: AppFlagValues): Result<EnsureOptions | undefined> {
	const install = parseInstallFlags(opts);
	if (!install.success) return install;
	if (opts.app) {
		if (kindWithVariant(opts)) return err("--kind and --variant can't be combined");
		return ok({
			eas: opts.eas,
			build: opts.build,
			...install.data,
			...(opts.project !== undefined ? { project: opts.project } : {}),
			...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
			...(opts.variant !== undefined ? { variant: opts.variant } : {}),
			...(opts.kind !== undefined ? { kind: opts.kind } : {}),
		});
	}
	const sub = opts.project ?? opts.bundleId ?? opts.variant ?? opts.kind;
	if (sub !== undefined || !opts.eas || !opts.build || install.data.installMode !== undefined) {
		return err(
			"--project / --no-eas / --no-build / --bundle-id / --variant / --kind / --install-mode / --reset-keychain / --clean need --app"
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
	/** `--app` progress: what each source (`prepare:<platform>`, a device id) is doing, for the claim spinner */
	onAppPhase?: (source: string, phase: AppPhase) => void;
	/** a leg's devices are held — once per leg (`leg` is its index in `legFlags`), before its `--app` install, which can take minutes */
	onLeased?: (outcome: ClaimOutcome, leg: number) => void;
	/** checked before each device claim and before the installs: true → everything is released, `interrupted` */
	aborted?: () => boolean;
	/**
	 * awaited before a failed claim / install releases devices that were leased: work `onLeased` started
	 * on them (an early slim, a warm-up) must be done first, or it would touch a device another owner holds
	 */
	beforeRelease?: () => Promise<void>;
	/**
	 * a device the headless hide shut down and could not boot again is reported in `LeaseSession.lost`
	 * (still leased) instead of failing the claim, as long as some device is left (`warden batch` / `e2e`)
	 */
	dropLost?: boolean;
};

/** The error of a claim the caller gave up on (`aborted`) — nothing to add to it. */
export const INTERRUPTED = "interrupted";

/** One device's app, as `claimAll` reports it once every leg is in. */
type InstalledApp = { deviceId: string; result: EnsureResult };

/**
 * `--app`: ensure the app on every device of one claim in parallel (waits for all, then reports the first
 * failure); each device's install starts once `ready` says the device is up (16-8).
 */
async function installLegApp(
	ctx: CommandContext,
	ensure: RunEnsureApp,
	owner: Owner,
	claim: ClaimOutcome,
	opts: EnsureOptions,
	ready: (udid: string) => Promise<boolean> = async () => true,
	onPhase?: (source: string, phase: AppPhase) => void
): AsyncResult<InstalledApp[]> {
	const results = await Promise.all(
		claim.claimed.map(async (c) => {
			// a device the hide could not boot again is not installed on (batch-pipeline R5)
			if (!(await ready(c.device.id))) return undefined;
			const own = onPhase ? { ...opts, onPhase: (phase: AppPhase) => onPhase(c.device.id, phase) } : opts;
			return ensure(ctx, owner, c.device.platform, c.device.id, own);
		})
	);
	const apps: InstalledApp[] = [];
	for (const [i, c] of claim.claimed.entries()) {
		const res = results[i];
		if (!res) continue;
		if (!res.success) return err(`app on ${c.device.id}: ${res.error}`);
		apps.push({ deviceId: c.device.id, result: res.data });
	}
	return ok(apps);
}

/** One device claimed after the run started (`LeaseSession.claimMore`). */
export type MoreClaim = {
	outcome: ClaimOutcome;
	/** devices the headless hide could not boot again: still leased, not to be used */
	lost: string[];
	/** release just this claim's leases (the run no longer needs the device) */
	drop: () => Promise<void>;
};

export type MoreClaimOptions = {
	/** the claim to make: one device, usually at a lower priority than the run's own */
	flags: ClaimFlags;
	/** worker leg index handed to `onLeased` (the early warm-up numbers late workers by it) */
	leg: number;
	/** polled while the claim waits and before its install: true gives up (`INTERRUPTED`) */
	aborted: () => boolean;
	/** the device is held — before its `--app` install */
	onLeased?: (outcome: ClaimOutcome, leg: number) => void;
};

export type LeaseSession = {
	/** every claimed device, leg after leg */
	outcome: ClaimOutcome;
	/** the devices of each claim (`legFlags`, else the one claim), in order */
	claims: ClaimOutcome[];
	ports: RunPort[];
	env: Record<string, string | undefined>;
	leaseIds: string[];
	/** `dropLost`: devices the headless hide could not boot again; still leased, the caller drops them */
	lost?: string[];
	/** delete every lease and mark the devices used now */
	release: () => Promise<void>;
	/**
	 * Claim and install one more device while the run is going (elastic workers). Its leases join
	 * `leaseIds` — so the heartbeat and `release` cover them — unless the claim fails (nothing stays
	 * leased) or the caller `drop`s it.
	 */
	claimMore: (o: MoreClaimOptions) => AsyncResult<MoreClaim>;
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
	for (const platform of new Set((args.legFlags ?? [args.flags]).map((f) => f.request.platform))) {
		const onPhase = args.onAppPhase;
		app.warm(ctx, onPhase ? { ...args.app, onPhase: (p) => onPhase(`prepare:${platform}`, p) } : args.app, platform);
	}
	return app;
}

/**
 * One leg's outcome: its claim and, with `--app`, its install (undefined when the claim failed or there
 * is no app); `lost`: devices the headless hide could not boot again (`dropLost`).
 */
type LegRun = { claim: Result<ClaimOutcome>; install?: Result<InstalledApp[]> | undefined; lost?: string[] };

/** What a leg needs to install the app as soon as it is claimed. */
type LegInstall = { ensure: RunEnsureApp; opts: EnsureOptions };

const failure = (error: unknown): Result<never> => err(error instanceof Error ? error.message : String(error));

/**
 * A headless iOS claim's hide, overlapped with the leg's work (16-8): the devices the window close did
 * not shut down are leased (`leased`) and installed at once; a device the close shut down waits for
 * `settled` (its reboot), and so does `leased` then. `settled` is always awaited (it puts Simulator's
 * close setting back); `failed` lists the devices that did not come back (`leased` is then not called,
 * and their `ready` resolves false).
 */
export async function overlapHide<T>(
	hide: HideStart | undefined,
	o: { leased: () => void; install: (ready: (udid: string) => Promise<boolean>) => Promise<T> }
): Promise<{ result: T; failed: string[] }> {
	const down = new Set((hide ? await hide.down : []).map((s) => s.udid));
	const failed: Promise<string[]> = hide ? hide.settled.then((outcome) => outcome.failed ?? []) : Promise.resolve([]);
	if (down.size === 0) o.leased();
	const leased =
		down.size === 0
			? Promise.resolve()
			: failed.then((lost) => {
					if (lost.length === 0) o.leased();
				});
	const result = await o.install((udid) =>
		down.has(udid) ? failed.then((lost) => !lost.includes(udid)) : Promise.resolve(true)
	);
	await leased;
	return { result, failed: await failed };
}

/**
 * Claim one leg, then install the app on its devices without waiting for the other legs (nor, on a
 * headless iOS claim, for the hide's reboots of devices that stayed up: `overlapHide`). Never throws
 * and never releases: `claimAll` owns every lease once all legs have landed.
 */
async function runLeg(
	ctx: CommandContext,
	owner: Owner,
	leg: number,
	flags: ClaimFlags,
	args: LeaseArgs,
	pid: number,
	install: LegInstall | undefined
): Promise<LegRun> {
	if (args.aborted?.()) return { claim: err(INTERRUPTED) };
	let claim: Result<ClaimOutcome>;
	const hides: HideStart[] = [];
	try {
		claim = await claimWithFlags(ctx, owner, flags, pid, {
			onHide: (start) => hides.push(start),
			...(args.aborted ? { abort: args.aborted } : {}),
		});
	} catch (error) {
		await hides[0]?.settled;
		return { claim: failure(error) };
	}
	if (!claim.success) return { claim: claim.error === CLAIM_ABORTED ? err(INTERRUPTED) : claim };
	const outcome = claim.data;
	const { result, failed } = await overlapHide(hides[0], {
		leased: () => args.onLeased?.(outcome, leg),
		install: async (ready): Promise<LegRun["install"]> => {
			if (!install) return undefined;
			if (args.aborted?.()) return err(INTERRUPTED);
			try {
				return await installLegApp(ctx, install.ensure, owner, outcome, install.opts, ready, args.onAppPhase);
			} catch (error) {
				return failure(error);
			}
		},
	});
	// a device the hide shut down and could not boot again is unhealthy: the run does not go on with it
	if (failed.length > 0 && args.dropLost)
		return result === undefined ? { claim, lost: failed } : { claim, install: result, lost: failed };
	if (failed.length > 0) return { claim, install: err(lostText(failed)) };
	return result === undefined ? { claim } : { claim, install: result };
}

const lostText = (lost: readonly string[]) => `${lost.join(", ")} did not come back after the headless hide`;

/** Why the claimed legs cannot run: the first failed install, else every device lost to the hide. */
function legsFailure(
	runs: readonly LegRun[],
	outcome: ClaimOutcome,
	lost: readonly string[]
): Result<never> | undefined {
	const installFailed = runs.find((r) => r.install && !r.install.success)?.install;
	if (installFailed && !installFailed.success) return installFailed;
	if (lost.length > 0 && outcome.claimed.every((c) => lost.includes(c.device.id))) return err(lostText(lost));
	return undefined;
}

/**
 * One claim per leg (else the one `flags` claim), all at once: allocation is serialised by the
 * store's `BEGIN IMMEDIATE`, so legs cannot pick the same device, and a boot of one no longer waits
 * for the boot of the other. Each leg installs the app the moment it is claimed. `aborted` is
 * checked before a leg claims and before its install: a claim can boot simulators for a while, and
 * the caller may have lost its reason to continue (a Metro that failed, a signal) in the meantime.
 * Every leg is waited for, so a failure never leaves a still-booting claim holding a lease.
 */
async function runLegs(
	ctx: CommandContext,
	owner: Owner,
	args: LeaseArgs,
	pid: number,
	install: LegInstall | undefined
): Promise<LegRun[]> {
	return Promise.all(
		(args.legFlags ?? [args.flags]).map((flags, leg) => runLeg(ctx, owner, leg, flags, args, pid, install))
	);
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
	const ensure = args.app ? (deps.ensureApp ?? sessionApp?.ensure ?? sessionEnsureApp().ensure) : undefined;
	const runs = await runLegs(ctx, owner, args, deps.pid, ensure && args.app ? { ensure, opts: args.app } : undefined);
	const claims = runs.flatMap((r) => (r.claim.success ? [r.claim.data] : []));
	const claimFailed = runs.find((r) => !r.claim.success)?.claim;
	if (claimFailed && !claimFailed.success) {
		// a leg that was leased may already have a helper (the early warm-up): like any release, it stays resident
		await args.beforeRelease?.();
		await releaseDevices(
			ctx,
			claims.flatMap((c) => c.claimed.map((d) => d.lease.id)),
			{ touch: false }
		);
		await releasePorts();
		return claimFailed;
	}
	const outcome: ClaimOutcome = {
		claimed: claims.flatMap((c) => c.claimed),
		reclaimed: claims.flatMap((c) => c.reclaimed),
	};
	const leaseIds = [...outcome.claimed.map((c) => c.lease.id), ...portLeaseIds];
	const lost = runs.flatMap((r) => r.lost ?? []);
	// a release leaves each iOS device's `warden-simd` resident: the next run on the device reuses it (no spawn, no
	// handshake) and its idle timeout reaps it otherwise; `--shutdown` / a device shutdown / a new lease owner stop it
	const release = async () => {
		await releaseDevices(ctx, leaseIds);
	};
	const claimMore = async (o: MoreClaimOptions): AsyncResult<MoreClaim> => {
		const more: LeaseArgs = { ...args, aborted: o.aborted };
		delete more.onLeased;
		if (o.onLeased) more.onLeased = o.onLeased;
		const run = await runLeg(
			ctx,
			owner,
			o.leg,
			o.flags,
			more,
			deps.pid,
			ensure && args.app ? { ensure, opts: args.app } : undefined
		);
		if (!run.claim.success) return run.claim;
		const claimed = run.claim.data;
		const ids = claimed.claimed.map((c) => c.lease.id);
		if (run.install && !run.install.success) {
			await args.beforeRelease?.();
			await releaseDevices(ctx, ids, { touch: false });
			return run.install;
		}
		leaseIds.push(...ids);
		return ok({
			outcome: claimed,
			lost: run.lost ?? [],
			drop: async () => {
				for (const id of ids) {
					const at = leaseIds.indexOf(id);
					if (at >= 0) leaseIds.splice(at, 1);
				}
				await releaseDevices(ctx, ids);
			},
		});
	};
	const env = childEnv(ctx.env, outcome, ports.data);
	const headless = (args.legFlags ?? [args.flags]).some((f) => f.headless === true);
	setHeadlessEnv(env, headless);
	setAfterRebootEnv(env, headless);
	const failed = legsFailure(runs, outcome, lost);
	if (failed) {
		await args.beforeRelease?.();
		await release();
		return failed;
	}
	for (const app of runs.flatMap((r) => (r.install?.success ? r.install.data : []))) {
		ctx.err(`warden ${name}: app ${app.result.source} on ${app.deviceId} [${app.result.hash}]`);
		if (app.result.appPath) env.WARDEN_APP_PATH = app.result.appPath;
		env.WARDEN_APP_HASH = app.result.hash;
	}
	return ok({
		outcome,
		claims,
		ports: ports.data,
		env,
		release,
		claimMore,
		leaseIds,
		...(lost.length > 0 ? { lost } : {}),
	});
}

/** `leased <name>, …` — the claim spinner's line. */
export const leasedText = (outcome: ClaimOutcome) => `leased ${outcome.claimed.map((c) => c.device.name).join(", ")}`;

/**
 * With `--app` the app work runs under the claim spinner: report the lease the moment it is held,
 * so the lines that follow read as happening on leased devices. The spinner text itself comes from `appPhaseProgress`.
 */
export function leasedProgress(
	spinner: Spinner,
	color: CommandContext["ui"]["color"],
	app: boolean
): ((outcome: ClaimOutcome) => void) | undefined {
	if (!app) return undefined;
	return (outcome) => {
		spinner.log(`${color.green("✔")} ${leasedText(outcome)}`);
	};
}

/** With `--app`, the claim spinner follows what the app is really doing (see `appPhaseText`): building, fetching, repacking, installing. */
export function appPhaseProgress(spinner: Spinner, app: boolean): LeaseArgs["onAppPhase"] {
	return app ? phaseTracker((text) => spinner.update(text)) : undefined;
}

/** Why a run stops when its heartbeat finds some of its leases gone. */
export const LEASES_LOST =
	"leases were released by another process: warden release or SessionEnd — stopping so the devices are not driven by two owners";

/**
 * Heartbeat `leaseIds` now and every `HEARTBEAT_INTERVAL_MS` (each beat records the period, so a crashed
 * holder's leases go stale after a few missed beats instead of the TTL) and route SIGINT/SIGTERM to
 * `onSignal` until the returned stop function is called. A beat that updates fewer leases than it holds
 * means someone else released them: report `LEASES_LOST` and abort through `onSignal("SIGTERM")`, once.
 */
export function holdLeases(
	ctx: CommandContext,
	deps: Pick<LeaseSessionDeps, "every" | "onSignal">,
	leaseIds: readonly string[],
	onSignal: (signal: ForwardedSignal) => void
): () => void {
	const store = ctx.store();
	let lost = false;
	const beat = () => {
		if (lost) return;
		const updated = store.heartbeat([...leaseIds], ctx.now(), HEARTBEAT_INTERVAL_MS);
		if (updated >= leaseIds.length) return;
		lost = true;
		reportError(ctx, "lease", LEASES_LOST);
		onSignal("SIGTERM");
	};
	try {
		beat();
	} catch {
		// a busy store at start is not fatal: the next tick beats again
	}
	const stopHeartbeat = deps.every(HEARTBEAT_INTERVAL_MS, beat);
	const unsubscribe = FORWARDED_SIGNALS.map((signal) => deps.onSignal(signal, () => onSignal(signal)));
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
