import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { AppDeps, AppHost } from "@delacour/warden-builds/prepare";
import { DEFAULT_PROFILE, DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { hostDeps } from "@delacour/warden-core/host-deps";
import type { Driver } from "@delacour/warden-driver/driver.types";
import { helperLifecycle } from "@delacour/warden-driver-ios/helper";
import { allocator } from "@delacour/warden-leasing/allocate";
import { type ClaimRequest, ClaimRequestRunner } from "@delacour/warden-leasing/claim-request";
import { DeviceReleaser } from "@delacour/warden-leasing/device-lease";
import { ReleasedDeviceShutdown } from "@delacour/warden-leasing/device-shutdown";
import { headlessResolver } from "@delacour/warden-leasing/headless";
import type { HostFacts } from "@delacour/warden-leasing/host";
import type { LeaseHost } from "@delacour/warden-leasing/lease-host";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { LeaseHeartbeat } from "@delacour/warden-leasing/session";
import { processExec } from "@delacour/warden-runtime/exec";
import { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import { liveness } from "@delacour/warden-store/liveness";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { type DeviceRequest, type Lease, leaseModel, type Owner } from "@delacour/warden-store/types";
import type { WardenError as EngineError } from "@delacour/warden-types/error";
import type { WardenHost, WardenLogEvent } from "@delacour/warden-types/host";
import type { Result } from "@delacour/warden-types/result";
import { sdkErrors, WardenError } from "./errors";
import type { AuthoringDeps } from "./ops/authoring/deps";
import type { DevtoolsDeps } from "./ops/devtools";
import type { OpDevice } from "./ops/session";
import type { VideoDeps } from "./ops/video";
import type { PerfSeams } from "./perf";
import { configProviders } from "./plugins/config-providers";
import { type PluginProvider, type ProviderPlugin, providerRegistry } from "./plugins/define-provider";
import type {
	CallOptions,
	ClaimParams,
	LeaseOwnerInput,
	WardenClientOptions,
	WardenEvent,
	WardenEventHandler,
	WardenEventKind,
} from "./sdk.types";
import type { SpecsDeps } from "./specs.types";

/** How long a `wait` claim queues for a free device or host capacity before it fails with `device_busy`. */
export const WAIT_CLAIM_MS = 30 * 60_000;

/**
 * Test seams of the client (not part of the public contract): every one defaults to the real machine. A test
 * passes a `FakeDriver` through `openDriver` and a fake provider through `providerFor`.
 */
export type ClientSeams = {
	/** open the driver of a leased device (default: iOS `connectHelper`, Android `openDriver`) */
	openDriver?: (device: OpDevice, appId: string | undefined) => Promise<Result<Driver, EngineError>>;
	/** the device provider (default: the golden-aware iOS / Android providers of `warden-core`) */
	providerFor?: LeaseHost["providerFor"];
	/** stop a resident `warden-simd` after a device was shut down (default: `stopHelper`) */
	stopHelper?: (udid: string) => Promise<void>;
	/** how the devtools ops reach Metro and spawn the collector */
	devtools?: DevtoolsDeps;
	/** how `video start|stop` runs the recorder */
	video?: VideoDeps;
	/** how `session.record` finds the suite and runs a recorded spec (`verify` defaults to the specs runner, `warden e2e --specs <id> --json`) */
	authoring?: AuthoringDeps;
	/** app preparation effects */
	appDeps?: AppDeps;
	/** RAM + cores of the host for the capacity gate */
	hostFacts?: () => Promise<HostFacts>;
	/** an already open store (default: `$WARDEN_HOME/warden.db`, opened on first use) */
	store?: Store;
	/** how `specs.run` spawns the CLI (default: `Bun.spawn`) */
	specs?: SpecsDeps;
	/** how the perf facade reaches the process table, Metro, the collector and the device */
	perf?: PerfSeams;
};

/** Everything the namespaces share: one host, one store, one owner, the leases this client claimed. */
export type Core = {
	readonly options: WardenClientOptions;
	readonly host: WardenHost;
	readonly git: GitFactsCache;
	readonly owner: Owner;
	readonly seams: ClientSeams;
	/** the leases this client claimed, by id */
	readonly claimed: Map<string, Lease>;
	/** close hooks of the sessions opened through this client, by session id */
	readonly sessions: Map<string, () => Promise<void>>;
	/** teardown hooks of things the client started (Metro), run on close */
	readonly cleanups: Array<() => Promise<void>>;
	closed: boolean;
	store(): Store;
	/** close the store this client opened (a store handed in through the seams stays open) */
	closeStore(): void;
	appHost(): AppHost;
	leaseHost(): LeaseHost;
	/** the lease host with `provider` serving its platform (claims and shutdowns of a plugin's devices) */
	leaseHostWith(provider: PluginProvider): LeaseHost;
	/** the registered plugin's provider, set up on first use (`not_found` for an unknown name) */
	pluginProvider(name: string): Promise<PluginProvider>;
	/** every registered plugin: in code, then the config's `providers` (loaded once, on the first call that needs them) */
	registeredPlugins(): Promise<ReadonlyMap<string, ProviderPlugin>>;
	emit(event: WardenEvent): void;
	on<K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): () => void;
	off<K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): void;
	/** the client's signal combined with the call's */
	signalFor(opts?: CallOptions): AbortSignal | undefined;
	/** re-start the heartbeat over the leases claimed now */
	heartbeat(): void;
};

const IOS_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The injected, lazily wired state of one client ({@link CoreRuntime.create}). */
class ClientCore implements Core {
	readonly host: WardenHost;
	readonly git = new GitFactsCache();
	readonly owner: Owner;
	readonly claimed = new Map<string, Lease>();
	readonly sessions = new Map<string, () => Promise<void>>();
	readonly cleanups: Array<() => Promise<void>> = [];
	closed = false;
	private readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	private readonly cwd: string;
	private readonly listeners = new Map<WardenEventKind, Set<(event: never) => void>>();
	private readonly plugins: Map<string, ProviderPlugin>;
	private readonly setUp = new Map<string, Promise<PluginProvider>>();
	private configLoaded: Promise<void> | undefined;
	private openedStore: Store | undefined;
	private stopBeating: (() => void) | undefined;

	constructor(
		readonly options: WardenClientOptions,
		readonly seams: ClientSeams
	) {
		const overrides = options.host ?? {};
		const baseEnv = overrides.env ?? process.env;
		this.env = options.home === undefined ? baseEnv : { ...baseEnv, WARDEN_HOME: options.home };
		this.cwd = overrides.cwd ?? process.cwd();
		this.plugins = providerRegistry.register(options.providers);
		this.host = {
			env: this.env,
			cwd: this.cwd,
			home: storeLocator.wardenHome(this.env),
			now: overrides.now ?? (() => Date.now()),
			exec: overrides.exec ?? processExec.run,
			sleep: overrides.sleep ?? ((ms) => Bun.sleep(ms)),
			pidAlive: overrides.pidAlive ?? liveness.processAlive,
			log: (event) => {
				const mapped = coreRuntime.eventFromLog(event);
				if (mapped) this.emit(mapped);
			},
		};
		this.owner =
			options.owner === undefined
				? ownerResolver.resolve({ env: this.env, cwd: this.cwd, git: this.git })
				: this.ownerFrom(options.owner);
		this.openedStore = seams.store;
	}

	private ownerFrom(input: LeaseOwnerInput): Owner {
		switch (input.kind) {
			case "agent":
				return { kind: "agent", sessionId: input.sessionId, cwd: input.cwd ?? this.cwd };
			case "user":
				return { kind: "user", pid: input.pid ?? process.pid, cwd: input.cwd ?? this.cwd };
			case "ci":
				return { kind: "ci", runId: input.runId };
		}
	}

	readonly emit = (event: WardenEvent): void => {
		try {
			this.options.onEvent?.(event);
		} catch {
			// a listener's bug is not the call's failure
		}
		for (const handler of [...(this.listeners.get(event.kind) ?? [])]) {
			try {
				handler(event as never);
			} catch {
				// same: a handler's bug is not the call's failure
			}
		}
	};

	readonly registeredPlugins = async (): Promise<ReadonlyMap<string, ProviderPlugin>> => {
		this.configLoaded ??= configProviders
			.stopAt(this.host.exec, this.cwd, this.git, this.env)
			.then((stopAt) => configProviders.load(this.cwd, this.env, stopAt))
			.then((fromConfig) => {
				for (const plugin of fromConfig) {
					if (this.plugins.has(plugin.name)) {
						throw new WardenError({
							code: "duplicate_provider",
							message: `provider "${plugin.name}" is registered in code and in the config's providers`,
						});
					}
					this.plugins.set(plugin.name, plugin);
				}
			});
		try {
			await this.configLoaded;
		} catch (error) {
			this.configLoaded = undefined;
			throw error;
		}
		return this.plugins;
	};

	readonly store = (): Store => {
		if (this.openedStore !== undefined) return this.openedStore;
		const dbPath = storeLocator.defaultDbPath(this.env);
		const opened = storeLocator.open(dbPath);
		const found = opened.schemaVersion();
		const supported = storeLocator.supportedSchemaVersion();
		if (found > supported) {
			opened.close();
			throw new WardenError({
				code: "store_incompatible",
				message: `the warden store at ${dbPath} is schema v${found}, newer than this SDK supports (v${supported})`,
				hint: "run `warden update` (and upgrade @delacour/warden-sdk to the same version)",
				details: { found, supported },
			});
		}
		this.openedStore = opened;
		return opened;
	};

	readonly closeStore = (): void => {
		if (this.openedStore !== undefined && this.seams.store === undefined) this.openedStore.close();
		this.openedStore = undefined;
	};

	readonly appHost = (): AppHost => ({ ...this.host, store: this.store, git: this.git });

	readonly leaseHost = (): LeaseHost => {
		const app = this.appHost();
		const { seams } = this;
		return {
			...app,
			...(seams.hostFacts ? { hostFacts: seams.hostFacts } : {}),
			providerFor: seams.providerFor ?? ((platform, who) => hostDeps.providerFor(platform, app, who)),
			stopHelper:
				seams.stopHelper ??
				(async (udid) => {
					if (!IOS_UDID.test(udid)) return;
					await helperLifecycle.stop({ env: this.env, now: this.host.now, store: this.store }, udid);
				}),
		};
	};

	readonly leaseHostWith = (provider: PluginProvider): LeaseHost => {
		const base = this.leaseHost();
		return {
			...base,
			providerFor: (platform, who) => (platform === provider.platform ? provider : base.providerFor(platform, who)),
		};
	};

	readonly pluginProvider = async (name: string): Promise<PluginProvider> => {
		const plugin = this.plugins.get(name) ?? (await this.registeredPlugins()).get(name);
		if (!plugin) {
			throw new WardenError({
				code: "not_found",
				message: `no provider plugin "${name}"`,
				hint: `registered: ${[...this.plugins.keys()].join(", ") || "none"} (createWardenClient({ providers }) or providers in warden.config.ts)`,
			});
		}
		let ready = this.setUp.get(name);
		if (!ready) {
			const started = Promise.resolve(plugin.setup(this.pluginSetupContext(name)));
			ready = started;
			this.setUp.set(name, started);
			const dispose = plugin.dispose;
			if (dispose) {
				this.cleanups.push(async () => {
					await started;
					await dispose.call(plugin);
				});
			}
		}
		return ready;
	};

	private pluginSetupContext(name: string): Parameters<ProviderPlugin["setup"]>[0] {
		return {
			exec: this.host.exec,
			store: this.store(),
			env: this.env,
			now: this.host.now,
			owner: this.owner,
			cwd: this.cwd,
			home: this.host.home,
			log: (line) => this.host.log?.({ kind: "progress", phase: `provider:${name}`, message: line }),
		};
	}

	readonly on = <K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): (() => void) => {
		const set = this.listeners.get(kind) ?? new Set<(event: never) => void>();
		set.add(handler as (event: never) => void);
		this.listeners.set(kind, set);
		return () => this.off(kind, handler);
	};

	readonly off = <K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): void => {
		this.listeners.get(kind)?.delete(handler as (event: never) => void);
	};

	readonly signalFor = (opts?: CallOptions): AbortSignal | undefined => {
		const signals = [this.options.signal, opts?.signal].filter((s): s is AbortSignal => s !== undefined);
		if (signals.length === 0) return undefined;
		return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	};

	readonly heartbeat = (): void => {
		this.stopBeating?.();
		this.stopBeating = undefined;
		const ids = [...this.claimed.keys()];
		if (ids.length === 0) return;
		this.stopBeating = new LeaseHeartbeat(
			{ store: this.store, now: this.host.now, log: this.host.log },
			{
				every: (ms, fn) => {
					const timer = setInterval(fn, ms);
					timer.unref();
					return () => clearInterval(timer);
				},
				onSignal: () => () => undefined,
			}
		).hold(ids, () => undefined);
	};
}

/** The client's shared plumbing: the core, abort guards, `Result` unwrapping, and the claim / release flows. */
export class CoreRuntime {
	/** The injected, lazily wired state of a client. */
	create(options: WardenClientOptions, seams: ClientSeams = {}): Core {
		return new ClientCore(options, seams);
	}

	/** A {@link WardenLogEvent} as the public event; lease events are emitted by the client itself, with the lease. */
	eventFromLog(event: WardenLogEvent): WardenEvent | undefined {
		switch (event.kind) {
			case "progress":
				return { kind: "progress", message: event.message };
			case "warn":
				return { kind: "warn", message: event.message };
			case "debug":
				return { kind: "debug", message: event.message };
			case "fingerprint":
				return { kind: "progress", message: `fingerprint ${event.platform} ${event.key}` };
			case "lease":
				return undefined;
		}
	}

	/** Sleep that rejects when `signal` aborts (the call wrapper turns the rejection into `interrupted`). */
	abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(sdkErrors.interrupted());
				return;
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(sdkErrors.interrupted());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** `sleep(ms)` that returns early (resolves) once `signal` aborts, so a claim notices the abort at its next round. */
	private sleepUnlessAborted(
		sleep: (ms: number) => Promise<void>,
		ms: number,
		signal: AbortSignal | undefined
	): Promise<void> {
		if (!signal) return sleep(ms);
		if (signal.aborted) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				signal.removeEventListener("abort", done);
				resolve();
			};
			signal.addEventListener("abort", done, { once: true });
			sleep(ms).then(done, done);
		});
	}

	/** Throw the call's abort as `interrupted`. */
	guard(signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw sdkErrors.interrupted();
	}

	/** The value of an engine `Result`, or the thrown {@link WardenError}. */
	unwrap<T>(result: Result<T, EngineError>): T {
		if (result.success) return result.data;
		throw sdkErrors.toWardenError(result.error);
	}

	/** The value of a `Result` whose error is plain text, or a {@link WardenError} with `code`. */
	unwrapText<T>(result: Result<T, string>, code: EngineError["code"] = "failed"): T {
		if (result.success) return result.data;
		throw new WardenError({ code, message: result.error });
	}

	/** Run `work`, turning anything it throws into a {@link WardenError} (`interrupted` when `signal` aborted). */
	async guarded<T>(signal: AbortSignal | undefined, work: () => Promise<T> | T): Promise<T> {
		this.guard(signal);
		try {
			return await work();
		} catch (error) {
			throw sdkErrors.fromThrown(error, signal);
		}
	}

	/** The {@link ClaimRequest} for `params` under the client's defaults. */
	claimRequestFor(core: Core, params: ClaimParams): ClaimRequest {
		const count = params.count ?? 1;
		const request: DeviceRequest = {
			platform: params.platform,
			profile: params.profile ?? DEFAULT_PROFILE[params.platform],
			count,
			max: Math.max(allocator.defaultMax(availableParallelism()), count),
		};
		if (params.runtime !== undefined) request.runtime = params.runtime;
		if (params.adopt) request.adopt = true;
		const policy = params.lockPolicy ?? core.options.lockPolicy ?? "wait";
		const flags: ClaimRequest = {
			request,
			waitMs: policy === "reject" ? 0 : WAIT_CLAIM_MS,
			ttlMs: params.ttlMs ?? DEFAULT_TTL_MS,
			maxDefaulted: true,
		};
		if (core.options.priority !== undefined) flags.priority = core.options.priority;
		if (core.options.label !== undefined) flags.label = core.options.label;
		if (headlessResolver.resolve({ env: core.host.env })) flags.headless = true;
		return flags;
	}

	/** Remember a claimed lease and announce it; a device the owner booted too. */
	private recordClaimed(core: Core, lease: Lease): void {
		core.claimed.set(lease.id, lease);
		core.emit({ kind: "lease:claimed", lease });
		if (lease.bootedByOwner === true && lease.resource.kind === "device") {
			core.emit({
				kind: "device:booted",
				leaseId: lease.id,
				deviceId: lease.resource.id,
				platform: lease.resource.platform,
			});
		}
	}

	/**
	 * The claim's `onLeased` hook: stamps `provider` and `shared` on the lease rows inside the claim transaction,
	 * so a lease is never visible (to another process, or to the heartbeat) without them.
	 */
	private onLeasedFor(core: Core, params: ClaimParams): { onLeased?: (claimed: readonly { lease: Lease }[]) => void } {
		if (params.provider === undefined && params.shared !== true) return {};
		return {
			onLeased: (claimed) => {
				const ids = claimed.map((c) => c.lease.id);
				const store = core.store();
				if (params.provider !== undefined) store.setLeaseProvider(ids, params.provider);
				if (params.shared === true) store.markShared(ids);
			},
		};
	}

	/** Claim devices for `params`; the client keeps (and heartbeats) the leases until it closes or releases them. */
	async claimDevices(core: Core, params: ClaimParams, opts?: CallOptions): Promise<Lease[]> {
		const signal = core.signalFor(opts);
		return this.guarded(signal, async () => {
			const plugin = params.provider === undefined ? undefined : await core.pluginProvider(params.provider);
			if (plugin && plugin.platform !== params.platform) {
				throw new WardenError({
					code: "usage",
					message: `provider "${params.provider}" serves ${plugin.platform}, not ${params.platform}`,
				});
			}
			const host = plugin ? core.leaseHostWith(plugin) : core.leaseHost();
			const outcome = this.unwrap(
				await new ClaimRequestRunner(host).claim(core.owner, this.claimRequestFor(core, params), process.pid, {
					abort: () => signal?.aborted === true,
					sleep: (ms) => this.sleepUnlessAborted(core.host.sleep, ms, signal),
					...this.onLeasedFor(core, params),
				})
			);
			const leases = outcome.claimed.map((c) => c.lease);
			for (const lease of leases) this.recordClaimed(core, lease);
			core.heartbeat();
			return leases;
		});
	}

	/**
	 * Release `leases` (all must be the client's owner's): devices `shutdown` allows are shut down first (policy:
	 * `shutdownReleasedDevices`: warden-created devices and ones the owner booted), then the leases are deleted.
	 */
	async releaseLeases(core: Core, leases: Lease[], shutdown: boolean): Promise<ReleaseOutcome> {
		const devices = leases.filter((l) => l.resource.kind === "device");
		const outcome: { shutdown: string[]; notes: string[] } = { shutdown: [], notes: [] };
		if (shutdown && devices.length > 0) {
			const groups = new Map<string | undefined, Lease[]>();
			for (const lease of leases) {
				const key = lease.provider;
				groups.set(key, [...(groups.get(key) ?? []), lease]);
			}
			for (const [name, group] of groups) {
				const host = name === undefined ? core.leaseHost() : core.leaseHostWith(await core.pluginProvider(name));
				const done = await new ReleasedDeviceShutdown(host).run(group, core.owner);
				outcome.shutdown.push(...done.shutdown);
				outcome.notes.push(...done.notes);
			}
		}
		const lh = core.leaseHost();
		const deleted = await new DeviceReleaser({ store: core.store, now: core.host.now }).release(
			leases.map((l) => l.id),
			shutdown ? { after: lh.stopHelper } : {}
		);
		for (const lease of deleted) {
			core.claimed.delete(lease.id);
			core.emit({ kind: "lease:released", leaseId: lease.id });
		}
		core.heartbeat();
		return { released: deleted.map((l) => l.id), shutdown: outcome.shutdown, notes: outcome.notes };
	}

	/** The store's leases for `ids`, refusing any the client's owner does not hold (`lease_foreign`) or that do not exist. */
	ownLeases(core: Core, ids: readonly string[]): Lease[] {
		const store = core.store();
		return ids.map((id) => {
			const lease = store.getLease(id);
			if (!lease)
				throw new WardenError({ code: "lease_not_found", message: `no lease ${id}`, hint: "see leases.list()" });
			if (!leaseModel.sameOwner(lease.owner, core.owner)) {
				throw new WardenError({
					code: "lease_foreign",
					message: `lease ${id} is held by someone else`,
					details: { leaseId: id },
				});
			}
			return lease;
		});
	}

	/** `$WARDEN_HOME/ui/<id>` of the SDK's per-device scratch (shots, videos, logs). */
	deviceDir(core: Core, id: string): string {
		return join(core.host.home, "ui", id);
	}
}

/** What a release did. */
export type ReleaseOutcome = { released: string[]; shutdown: string[]; notes: string[] };

export const coreRuntime = new CoreRuntime();
