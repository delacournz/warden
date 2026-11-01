import { constants } from "node:os";
import type { KindApp } from "@delacour/warden-builds/ensure-kind";
import { AppPreparer, defaultAppDeps, type EnsureOptions, type PreparedApp } from "@delacour/warden-builds/prepare";
import type { AppPhase, EnsureResult } from "@delacour/warden-builds/resolve";
import { DEFAULT_TTL_MS, HEARTBEAT_INTERVAL_MS } from "@delacour/warden-config/config.defaults";
import { portSpecParser } from "@delacour/warden-config/ports-spec";
import { leaseModel, type Owner, type Platform } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { ClaimOutcome, ClaimResult } from "./claim";
import { type ClaimRequest, ClaimRequestRunner } from "./claim-request";
import { DeviceReleaser } from "./device-lease";
import type { LeaseHost } from "./lease-host";
import { PortAllocator } from "./ports";
import type { HideStart } from "./sim-windows";

/** Shared by `warden run` and `warden batch`: claim devices + ports, child env, heartbeat, release. */

/** Signals a run forwards to its child and ends on: Ctrl-C, a kill, and the terminal going away. */
export type ForwardedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export const FORWARDED_SIGNALS: readonly ForwardedSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export type ChildHandle = { exited: Promise<number>; kill: (signal: ForwardedSignal) => void };

export type RunEnsureApp = (
	host: LeaseHost,
	owner: Owner,
	platform: Platform,
	deviceId: string,
	opts: EnsureOptions
) => AsyncResult<EnsureResult & { kindApp?: KindApp }, WardenError>;

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

/** One device's app, as `claimAll` reports it once every leg is in. */
type InstalledApp = { deviceId: string; result: EnsureResult };

/**
 * What to lease: devices (claim flags), `--port` specs and optionally the app on each device.
 * `legFlags` (the device legs of an e2e suite) are claimed instead of `flags`, one claim each, in order.
 */
export type LeaseArgs = {
	flags: ClaimRequest;
	legFlags?: readonly ClaimRequest[];
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
	/** the CLI's own command (`selfCommand()`): lets a rebooted sim's window be reopened (`WARDEN_AFTER_REBOOT`) */
	self?: readonly string[];
};

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
	flags: ClaimRequest;
	/** worker leg index handed to `onLeased` (the early warm-up numbers late workers by it) */
	leg: number;
	/** polled while the claim waits and before its install: true gives up (`interrupted`) */
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
	claimMore: (o: MoreClaimOptions) => AsyncResult<MoreClaim, WardenError>;
};

/** The two halves of an ensure, injectable for tests: the device-independent prepare and the per-device install. */
export type SessionAppDeps = {
	prepare: (host: LeaseHost, opts: EnsureOptions, platform: Platform) => AsyncResult<PreparedApp, WardenError>;
	install: (
		host: LeaseHost,
		owner: Owner,
		platform: Platform,
		deviceId: string,
		opts: EnsureOptions,
		app: PreparedApp
	) => AsyncResult<EnsureResult & { kindApp?: KindApp }, WardenError>;
};

/** One session's app: `warm` starts the fingerprint early, `ensure` installs on one device once it is in. */
export type SessionApp = {
	/** load + fingerprint the project for `platform` now (idempotent); nothing depends on a device yet */
	warm: (host: LeaseHost, opts: EnsureOptions, platform: Platform) => void;
	ensure: RunEnsureApp;
};

/**
 * One leg's outcome: its claim and, with `--app`, its install (undefined when the claim failed or there
 * is no app); `lost`: devices the headless hide could not boot again (`dropLost`).
 */
type LegRun = {
	claim: Result<ClaimOutcome, WardenError>;
	install?: Result<InstalledApp[], WardenError> | undefined;
	lost?: string[];
};

/** What a leg needs to install the app as soon as it is claimed. */
type LegInstall = { ensure: RunEnsureApp; opts: EnsureOptions };

/** The text of a claim the caller gave up on (`aborted`); its error code is `interrupted`. */
export const INTERRUPTED = "interrupted";

/** Why a run stops when its heartbeat finds some of its leases gone. */
export const LEASES_LOST =
	"leases were released by another process: warden release or SessionEnd — stopping so the devices are not driven by two owners";

const defaultSessionAppDeps: SessionAppDeps = {
	prepare: (host, opts, platform) => new AppPreparer(host, defaultAppDeps).prepare(opts, platform),
	install: (host, owner, platform, deviceId, opts, app) =>
		new AppPreparer(host, defaultAppDeps).ensurePrepared(owner, platform, deviceId, opts, app),
};

/** The default signal and timer seams of a lease session (processes subscribe on `process`, ticks are `setInterval`). */
export class SessionSignals {
	/** Default `onSignal`: subscribe on `process`. */
	readonly onSignal = (signal: ForwardedSignal, handler: () => void): (() => void) => {
		process.on(signal, handler);
		return () => {
			process.off(signal, handler);
		};
	};

	/** Default `every`: `setInterval`. */
	readonly every = (ms: number, fn: () => void): (() => void) => {
		const timer = setInterval(fn, ms);
		return () => clearInterval(timer);
	};
}

export const sessionSignals = new SessionSignals();

/** Pure rules of a lease session: child env, exit codes, failures and the hide overlap. */
export class SessionRules {
	/** The failed result of a claim the caller gave up on — nothing to add to it. */
	interrupted(): Result<never, WardenError> {
		return wardenErrors.err("interrupted", INTERRUPTED);
	}

	failure(error: unknown): Result<never, WardenError> {
		return wardenErrors.err("failed", error instanceof Error ? error.message : String(error));
	}

	lostText(lost: readonly string[]): string {
		return `${lost.join(", ")} did not come back after the headless hide`;
	}

	/** `leased <name>, …` — the claim spinner's line. */
	leasedText(outcome: ClaimOutcome): string {
		return `leased ${outcome.claimed.map((c) => c.device.name).join(", ")}`;
	}

	/** Env for the child: `WARDEN_UDIDS`, `WARDEN_UDID_<i>`, `WARDEN_LEASE_IDS`, `WARDEN_PORT(S)`. */
	childEnv(
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
		// a run on phones only says so; a mixed run is told per device by the jobs' own env (batch / e2e)
		if (outcome.claimed.length > 0 && outcome.claimed.every((c) => leaseModel.isPhysicalDevice(c.device))) {
			env.WARDEN_DEVICE_KIND = "physical";
		} else delete env.WARDEN_DEVICE_KIND;
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
	setHeadlessEnv(env: Record<string, string | undefined>, headless: boolean): void {
		if (headless) env.WARDEN_HEADLESS = "1";
		else delete env.WARDEN_HEADLESS;
	}

	/**
	 * `WARDEN_AFTER_REBOOT` in a child env for a non-headless macOS run: the argv the e2e session runs after it rebooted a
	 * sim whose HID connection was lost (`warden arrange --open <udid>`: reopen the sim's Device Hub window, tile again).
	 * `packages/e2e` cannot import the CLI, so the seam is an env var holding a JSON argv, like `WARDEN_LAUNCH_ARGS`.
	 * `self` is the CLI's own command (the caller knows it); none, headless or not macOS: removed, so children never
	 * inherit the parent's.
	 */
	setAfterRebootEnv(
		env: Record<string, string | undefined>,
		headless: boolean,
		self: readonly string[] | undefined,
		os: NodeJS.Platform = process.platform
	): void {
		if (headless || os !== "darwin" || self === undefined) delete env.WARDEN_AFTER_REBOOT;
		else env.WARDEN_AFTER_REBOOT = JSON.stringify([...self, "arrange", "--open", "{udid}"]);
	}

	/**
	 * The headless and after-reboot env of a run. Phones are never rebooted, so a run with only phones has nothing to
	 * reopen afterwards.
	 */
	setRunEnv(
		env: Record<string, string | undefined>,
		legs: readonly ClaimRequest[],
		self: readonly string[] | undefined
	): void {
		const headless = legs.some((f) => f.headless === true);
		this.setHeadlessEnv(env, headless);
		this.setAfterRebootEnv(env, headless, self);
		if (legs.every((f) => f.request.physical !== undefined)) delete env.WARDEN_AFTER_REBOOT;
	}

	/** Shell-style exit code of a finished Bun subprocess: `128 + signal` when it was killed. */
	exitCodeOf(proc: { signalCode: string | null }, code: number): number {
		return proc.signalCode ? 128 + this.signalNumber(proc.signalCode) : code;
	}

	/** Why the claimed legs cannot run: the first failed install, else every device lost to the hide. */
	legsFailure(
		runs: readonly LegRun[],
		outcome: ClaimOutcome,
		lost: readonly string[]
	): Result<never, WardenError> | undefined {
		const installFailed = runs.find((r) => r.install && !r.install.success)?.install;
		if (installFailed && !installFailed.success) return installFailed;
		if (lost.length > 0 && outcome.claimed.every((c) => lost.includes(c.device.id)))
			return wardenErrors.err("failed", this.lostText(lost));
		return undefined;
	}

	/**
	 * A headless iOS claim's hide, overlapped with the leg's work (16-8): the devices the window close did
	 * not shut down are leased (`leased`) and installed at once; a device the close shut down waits for
	 * `settled` (its reboot), and so does `leased` then. `settled` is always awaited (it puts Simulator's
	 * close setting back); `failed` lists the devices that did not come back (`leased` is then not called,
	 * and their `ready` resolves false).
	 */
	async overlapHide<T>(
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

	private signalNumber(signal: string | null | undefined): number {
		if (!signal) return 0;
		const n = (constants.signals as Record<string, number | undefined>)[signal];
		return n ?? 0;
	}
}

export const sessionRules = new SessionRules();

/** Leases one port per `--port FROM:SPAN` spec for a run. */
export class RunPortClaimer {
	constructor(private readonly host: Pick<LeaseHost, "store" | "now" | "pidAlive">) {}

	/** Lease one port per `--port FROM:SPAN` spec for `owner` (lease `pid`); all-or-nothing. */
	async claim(
		owner: Owner,
		specs: readonly string[],
		pid: number,
		isFree: (port: number) => Promise<boolean>,
		label = "warden run"
	): AsyncResult<RunPort[], WardenError> {
		const { host } = this;
		const allocator = new PortAllocator(host.store());
		const ports: RunPort[] = [];
		for (const spec of specs) {
			const range = wardenErrors.coded(portSpecParser.parse(spec), "usage");
			const claimed = range.success
				? await allocator.claim(
						{ owner, ...range.data, ttlMs: DEFAULT_TTL_MS, pid, label },
						{ now: host.now, pidAlive: host.pidAlive, isPortFree: isFree }
					)
				: range;
			if (!claimed.success) {
				await new DeviceReleaser(host).release(
					ports.map((p) => p.leaseId),
					{ touch: false }
				);
				return claimed;
			}
			for (const lease of claimed.data) {
				if (lease.resource.kind === "port") ports.push({ leaseId: lease.id, port: lease.resource.port });
			}
		}
		return resultFactory.ok(ports);
	}
}

/** Keeps a run's leases alive and routes signals to the run. */
export class LeaseHeartbeat {
	constructor(
		private readonly host: Pick<LeaseHost, "store" | "now" | "log">,
		private readonly deps: Pick<LeaseSessionDeps, "every" | "onSignal">
	) {}

	/**
	 * Heartbeat `leaseIds` now and every `HEARTBEAT_INTERVAL_MS` (each beat records the period, so a crashed
	 * holder's leases go stale after a few missed beats instead of the TTL) and route SIGINT/SIGTERM to
	 * `onSignal` until the returned stop function is called. A beat that updates fewer leases than it holds
	 * means someone else released them: report `LEASES_LOST` (a `warn` event, scope `lease`) and abort
	 * through `onSignal("SIGTERM")`, once.
	 */
	hold(leaseIds: readonly string[], onSignal: (signal: ForwardedSignal) => void): () => void {
		const { host, deps } = this;
		const store = host.store();
		let lost = false;
		const beat = () => {
			if (lost) return;
			const updated = store.heartbeat([...leaseIds], host.now(), HEARTBEAT_INTERVAL_MS);
			if (updated >= leaseIds.length) return;
			lost = true;
			host.log?.({ kind: "warn", scope: "lease", message: LEASES_LOST });
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
}

/**
 * The default `ensureApp` of one session: the project is loaded and fingerprinted once per platform
 * (started by `warm` as soon as the ports are leased, so it overlaps the device boot), then installed
 * on each device (N devices used to mean N fingerprint runs).
 */
export class SessionAppEnsurer implements SessionApp {
	private readonly prepared = new Map<string, AsyncResult<PreparedApp, WardenError>>();

	constructor(private readonly deps: SessionAppDeps = defaultSessionAppDeps) {}

	readonly warm = (host: LeaseHost, opts: EnsureOptions, platform: Platform): void => {
		// a throw surfaces where `ensure` awaits the same promise; nothing must trip on it before that
		this.prepare(host, opts, platform).catch(() => undefined);
	};

	readonly ensure: RunEnsureApp = async (host, owner, platform, deviceId, opts) => {
		const app = await this.prepare(host, opts, platform);
		if (!app.success) return app;
		return this.deps.install(host, owner, platform, deviceId, opts, app.data);
	};

	// phones and simulators of one platform install different builds (an iPhone's is signed for a device)
	private prepare(host: LeaseHost, opts: EnsureOptions, platform: Platform): AsyncResult<PreparedApp, WardenError> {
		const key = `${platform}${opts.physical ? ":physical" : ""}`;
		const pending = this.prepared.get(key) ?? this.deps.prepare(host, opts, platform);
		this.prepared.set(key, pending);
		return pending;
	}
}

/**
 * Lease the ports, claim the devices and (with `--app`) ensure the app; on any failure nothing stays
 * leased. The ports come first (a bind probe, cheap) so `onPorts` can start the run's Metro while the
 * devices boot and the app installs. Port leases carry `--label` too (default `warden <name>`).
 */
export class LeaseSessionRunner {
	private readonly releaser: DeviceReleaser;

	constructor(
		private readonly host: LeaseHost,
		private readonly deps: Pick<LeaseSessionDeps, "pid" | "isPortFree" | "ensureApp">
	) {
		this.releaser = new DeviceReleaser(host);
	}

	async claimAll(owner: Owner, args: LeaseArgs, name = "run"): AsyncResult<LeaseSession, WardenError> {
		const { host, deps } = this;
		const label = args.flags.label ?? `warden ${name}`;
		const ports = await new RunPortClaimer(host).claim(owner, args.ports, deps.pid, deps.isPortFree, label);
		if (!ports.success) return ports;
		const portLeaseIds = ports.data.map((p) => p.leaseId);
		const releasePorts = () => this.releaser.release(portLeaseIds, { touch: false });
		args.onPorts?.(ports.data);
		const sessionApp = this.warmSessionApp(args);
		if (args.aborted?.()) {
			await releasePorts();
			return sessionRules.interrupted();
		}
		const ensure = args.app ? (deps.ensureApp ?? sessionApp?.ensure ?? new SessionAppEnsurer().ensure) : undefined;
		const install = ensure && args.app ? { ensure, opts: args.app } : undefined;
		const runs = await this.runLegs(owner, args, install);
		const claims = runs.flatMap((r) => (r.claim.success ? [r.claim.data] : []));
		const claimFailed = runs.find((r) => !r.claim.success)?.claim;
		if (claimFailed && !claimFailed.success) {
			// a leg that was leased may already have a helper (the early warm-up): like any release, it stays resident
			await args.beforeRelease?.();
			await this.releaser.release(
				claims.flatMap((c) => c.claimed.map((d) => d.lease.id)),
				{ touch: false }
			);
			await releasePorts();
			return claimFailed;
		}
		return this.assemble(owner, args, name, { ports: ports.data, portLeaseIds, runs, claims, install });
	}

	/** Every leg landed: the session (env, release, `claimMore`), or the failure of its installs. */
	private async assemble(
		owner: Owner,
		args: LeaseArgs,
		name: string,
		legs: {
			ports: RunPort[];
			portLeaseIds: string[];
			runs: LegRun[];
			claims: ClaimOutcome[];
			install: LegInstall | undefined;
		}
	): AsyncResult<LeaseSession, WardenError> {
		const { host } = this;
		const { ports, portLeaseIds, runs, claims, install } = legs;
		const outcome: ClaimOutcome = {
			claimed: claims.flatMap((c) => c.claimed),
			reclaimed: claims.flatMap((c) => c.reclaimed),
		};
		const leaseIds = [...outcome.claimed.map((c) => c.lease.id), ...portLeaseIds];
		const lost = runs.flatMap((r) => r.lost ?? []);
		// a release leaves each iOS device's `warden-simd` resident: the next run on the device reuses it (no spawn, no
		// handshake) and its idle timeout reaps it otherwise; `--shutdown` / a device shutdown / a new lease owner stop it
		const release = async () => {
			await this.releaser.release(leaseIds);
		};
		const env = sessionRules.childEnv(host.env, outcome, ports);
		sessionRules.setRunEnv(env, args.legFlags ?? [args.flags], args.self);
		const failed = sessionRules.legsFailure(runs, outcome, lost);
		if (failed) {
			await args.beforeRelease?.();
			await release();
			return failed;
		}
		for (const app of runs.flatMap((r) => (r.install?.success ? r.install.data : []))) {
			host.log?.({
				kind: "progress",
				phase: "raw",
				message: `warden ${name}: app ${app.result.source} on ${app.deviceId} [${app.result.hash}]`,
			});
			if (app.result.appPath) env.WARDEN_APP_PATH = app.result.appPath;
			env.WARDEN_APP_HASH = app.result.hash;
		}
		return resultFactory.ok({
			outcome,
			claims,
			ports,
			env,
			release,
			claimMore: (o) => this.claimMore(owner, args, install, leaseIds, o),
			leaseIds,
			...(lost.length > 0 ? { lost } : {}),
		});
	}

	/** One more device while the run is going; its leases join `leaseIds` unless the claim fails or the caller drops it. */
	private async claimMore(
		owner: Owner,
		args: LeaseArgs,
		install: LegInstall | undefined,
		leaseIds: string[],
		o: MoreClaimOptions
	): AsyncResult<MoreClaim, WardenError> {
		const more: LeaseArgs = { ...args, aborted: o.aborted };
		delete more.onLeased;
		if (o.onLeased) more.onLeased = o.onLeased;
		const run = await this.runLeg(owner, o.leg, o.flags, more, install);
		if (!run.claim.success) return run.claim;
		const claimed = run.claim.data;
		const ids = claimed.claimed.map((c) => c.lease.id);
		if (run.install && !run.install.success) {
			await args.beforeRelease?.();
			await this.releaser.release(ids, { touch: false });
			return run.install;
		}
		leaseIds.push(...ids);
		return resultFactory.ok({
			outcome: claimed,
			lost: run.lost ?? [],
			drop: async () => {
				for (const id of ids) {
					const at = leaseIds.indexOf(id);
					if (at >= 0) leaseIds.splice(at, 1);
				}
				await this.releaser.release(ids);
			},
		});
	}

	/** With `--app` and the default ensure: fingerprint every leg's platform now — it needs no device, the simulators boot meanwhile. */
	private warmSessionApp(args: LeaseArgs): SessionApp | undefined {
		const { host, deps } = this;
		if (!args.app || deps.ensureApp !== undefined) return undefined;
		const app = new SessionAppEnsurer();
		const legs = args.legFlags ?? [args.flags];
		const warmed = new Set<string>();
		for (const { request } of legs) {
			const { platform } = request;
			const physical = request.physical !== undefined;
			const key = `${platform}:${physical}`;
			if (warmed.has(key)) continue;
			warmed.add(key);
			const onPhase = args.onAppPhase;
			const base = physical ? { ...args.app, physical: true } : args.app;
			app.warm(host, onPhase ? { ...base, onPhase: (p) => onPhase(`prepare:${platform}`, p) } : base, platform);
		}
		return app;
	}

	/**
	 * One claim per leg (else the one `flags` claim), all at once: allocation is serialised by the
	 * store's `BEGIN IMMEDIATE`, so legs cannot pick the same device, and a boot of one no longer waits
	 * for the boot of the other. Each leg installs the app the moment it is claimed. `aborted` is
	 * checked before a leg claims and before its install: a claim can boot simulators for a while, and
	 * the caller may have lost its reason to continue (a Metro that failed, a signal) in the meantime.
	 * Every leg is waited for, so a failure never leaves a still-booting claim holding a lease.
	 */
	private async runLegs(owner: Owner, args: LeaseArgs, install: LegInstall | undefined): Promise<LegRun[]> {
		return Promise.all(
			(args.legFlags ?? [args.flags]).map((flags, leg) => this.runLeg(owner, leg, flags, args, install))
		);
	}

	/**
	 * Claim one leg, then install the app on its devices without waiting for the other legs (nor, on a
	 * headless iOS claim, for the hide's reboots of devices that stayed up: `overlapHide`). Never throws
	 * and never releases: `claimAll` owns every lease once all legs have landed.
	 */
	private async runLeg(
		owner: Owner,
		leg: number,
		flags: ClaimRequest,
		args: LeaseArgs,
		install: LegInstall | undefined
	): Promise<LegRun> {
		const { host, deps } = this;
		if (args.aborted?.()) return { claim: sessionRules.interrupted() };
		let claim: ClaimResult;
		const hides: HideStart[] = [];
		try {
			claim = await new ClaimRequestRunner(host).claim(owner, flags, deps.pid, {
				onHide: (start) => hides.push(start),
				...(args.aborted ? { abort: args.aborted } : {}),
			});
		} catch (error) {
			await hides[0]?.settled;
			return { claim: sessionRules.failure(error) };
		}
		if (!claim.success) {
			return { claim: claim.error.code === "claim_aborted" ? sessionRules.interrupted() : claim };
		}
		const outcome = claim.data;
		const { result, failed } = await sessionRules.overlapHide(hides[0], {
			leased: () => args.onLeased?.(outcome, leg),
			install: async (ready): Promise<LegRun["install"]> => {
				if (!install) return undefined;
				if (args.aborted?.()) return sessionRules.interrupted();
				try {
					return await new LegAppInstaller(host).install(
						install.ensure,
						owner,
						outcome,
						install.opts,
						ready,
						args.onAppPhase
					);
				} catch (error) {
					return sessionRules.failure(error);
				}
			},
		});
		// a device the hide shut down and could not boot again is unhealthy: the run does not go on with it
		if (failed.length > 0 && args.dropLost)
			return result === undefined ? { claim, lost: failed } : { claim, install: result, lost: failed };
		if (failed.length > 0) return { claim, install: wardenErrors.err("failed", sessionRules.lostText(failed)) };
		return result === undefined ? { claim } : { claim, install: result };
	}
}

/** Installs the `--app` on the devices of one claim. */
export class LegAppInstaller {
	constructor(private readonly host: LeaseHost) {}

	/**
	 * `--app`: ensure the app on every device of one claim in parallel (waits for all, then reports the first
	 * failure); each device's install starts once `ready` says the device is up (16-8).
	 */
	async install(
		ensure: RunEnsureApp,
		owner: Owner,
		claim: ClaimOutcome,
		opts: EnsureOptions,
		ready: (udid: string) => Promise<boolean> = async () => true,
		onPhase?: (source: string, phase: AppPhase) => void
	): AsyncResult<InstalledApp[], WardenError> {
		const { host } = this;
		const results = await Promise.all(
			claim.claimed.map(async (c) => {
				// a device the hide could not boot again is not installed on (batch-pipeline R5)
				if (!(await ready(c.device.id))) return undefined;
				const phone = leaseModel.isPhysicalDevice(c.device);
				// a phone gets a build made for it: Android checks the APK's ABIs first (`-r` over the same bundle id, never an
				// uninstall of another app); an iPhone gets the signed device build through devicectl
				const target = phone ? { ...opts, physical: true } : opts;
				const own = onPhase ? { ...target, onPhase: (phase: AppPhase) => onPhase(c.device.id, phase) } : target;
				return ensure(host, owner, c.device.platform, c.device.id, own);
			})
		);
		const apps: InstalledApp[] = [];
		for (const [i, c] of claim.claimed.entries()) {
			const res = results[i];
			if (!res) continue;
			if (!res.success) return wardenErrors.err(res.error.code, `app on ${c.device.id}: ${res.error.message}`);
			apps.push({ deviceId: c.device.id, result: res.data });
		}
		return resultFactory.ok(apps);
	}
}
