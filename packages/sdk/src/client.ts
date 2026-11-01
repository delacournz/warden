import { resolve } from "node:path";
import { buildCache } from "@delacour/warden-builds/cache";
import { projectConfig } from "@delacour/warden-builds/config";
import { installer } from "@delacour/warden-builds/install";
import { buildLock } from "@delacour/warden-builds/lock";
import { type Metro, MetroRunner, metroTools } from "@delacour/warden-builds/metro";
import { AppPreparer, defaultAppDeps, type EnsureOptions } from "@delacour/warden-builds/prepare";
import { prune } from "@delacour/warden-builds/prune";
import { DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { DEFAULT_PORT_SPAN, portSpecParser } from "@delacour/warden-config/ports-spec";
import { capacityMath } from "@delacour/warden-leasing/capacity";
import { CapacityDepsBuilder, capacityEnv } from "@delacour/warden-leasing/capacity-deps";
import { inventoryMarker } from "@delacour/warden-leasing/inventory";
import { PortAllocator, portProbe } from "@delacour/warden-leasing/ports";
import { gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { BuildsTable } from "@delacour/warden-store/builds-table";
import { liveness } from "@delacour/warden-store/liveness";
import { type InventoryDevice, type Lease, leaseModel, type Platform } from "@delacour/warden-store/types";
import { type ClientSeams, type Core, coreRuntime } from "./core";
import { DeviceWindows } from "./device-windows";
import { WardenError } from "./errors";
import { leaseViews } from "./lease-view";
import { PerfService } from "./perf";
import { PluginDevices } from "./plugins/plugin-devices";
import type {
	AppsNamespace,
	BuildInfo,
	CallOptions,
	CapacityInfo,
	DeviceInfo,
	DevicesListParams,
	DevicesNamespace,
	EnsureAppParams,
	EnsuredApp,
	InstallAppParams,
	InventoryEntry,
	LeaseCheck,
	LeasesNamespace,
	MetroNamespace,
	MetroStartParams,
	MetroStatus,
	PortClaimParams,
	PortsNamespace,
	ReleaseParams,
	ReleaseResult,
	SessionsNamespace,
	WardenClient,
	WardenClientOptions,
} from "./sdk.types";
import { sessionRuntime } from "./session";
import { SpecsService } from "./specs";

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const DEFAULT_PORT_FROM = 8091;
const METRO_FROM = 8081;
const METRO_READY_MS = 120_000;

type RunningMetro = { metro: Metro; portLease: Lease; project: string };

/** Pure shaping of inventory rows, builds and lease ids for the namespaces. */
class ClientShapes {
	leaseId(lease: Lease | string): string {
		return typeof lease === "string" ? lease : lease.id;
	}

	deviceInfo(device: InventoryDevice, leased: boolean): DeviceInfo {
		return {
			platform: device.platform,
			id: device.id,
			name: device.name,
			state: device.state,
			wardenCreated: device.wardenCreated,
			...(device.profile !== undefined ? { profile: device.profile } : {}),
			...(device.runtime !== undefined ? { runtime: device.runtime } : {}),
			leased,
			...(device.quarantined ? { quarantined: true } : {}),
		};
	}

	buildKey(b: { projectKey: string; platform: Platform; hash: string }): string {
		return `${b.projectKey}:${b.platform}:${b.hash}`;
	}

	/** One platform's rows: golden images are left out, `bootedOnly` keeps running devices, each row carries its lease. */
	inventoryRows(
		devices: ReturnType<typeof inventoryMarker.mark>,
		platform: Platform,
		leases: ReturnType<typeof leaseViews.aliveDevice>,
		bootedOnly: boolean
	): InventoryEntry[] {
		return devices
			.filter((device) => !device.golden && !(bootedOnly && device.state !== "booted"))
			.map((device) => {
				const held = leases.get(`${platform}:${device.id}`);
				const lease = held?.provider === undefined ? held : undefined;
				return { device: this.deviceInfo(device, lease !== undefined), ...(lease ? { lease } : {}) };
			});
	}

	ensureOptions(params: EnsureAppParams): EnsureOptions {
		return {
			eas: true,
			build: true,
			...(params.project !== undefined ? { project: params.project } : {}),
			...(params.profile !== undefined ? { variant: params.profile } : {}),
		};
	}

	/** The `running` answer of `metro.start`. */
	metroStatusOf(port: number, url: string, project: string) {
		return { running: true as const, port, url, pid: process.pid, project };
	}
}

const shapes = new ClientShapes();

/** The namespaces of one client, each built over the shared {@link Core}. */
class WardenClientImpl implements WardenClient {
	private readonly core: Core;
	private readonly metroRunning = new Map<string, RunningMetro>();
	readonly devices: DevicesNamespace;
	readonly leases: LeasesNamespace;
	readonly ports: PortsNamespace;
	readonly apps: AppsNamespace;
	readonly metro: MetroNamespace;
	readonly sessions: SessionsNamespace;
	readonly specs: WardenClient["specs"];
	readonly perf: WardenClient["perf"];
	readonly on: WardenClient["on"];
	readonly off: WardenClient["off"];

	constructor(options: WardenClientOptions, seams: ClientSeams) {
		this.core = coreRuntime.create(options, seams);
		this.devices = this.buildDevices();
		this.leases = this.buildLeases();
		this.ports = this.buildPorts();
		this.apps = this.buildApps();
		this.metro = this.buildMetro();
		this.sessions = this.buildSessions();
		this.specs = new SpecsService(this.core).namespace();
		this.perf = new PerfService(this.core).namespace();
		this.on = this.core.on;
		this.off = this.core.off;
	}

	readonly close = async (opts?: CallOptions): Promise<void> => {
		const core = this.core;
		if (core.closed) return;
		core.closed = true;
		const failures = await this.closeEverything();
		core.closeStore();
		const first = failures[0];
		if (first !== undefined && opts?.signal?.aborted !== true)
			throw first instanceof WardenError ? first : new WardenError({ code: "failed", message: String(first) });
	};

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	/** Devices (golden images excluded) of the platforms asked for, with the lease holding each. */
	private async inventoryOf(params: DevicesListParams | undefined): Promise<InventoryEntry[]> {
		const core = this.core;
		const store = core.store();
		const lh = core.leaseHost();
		const platforms = params?.platform ? [params.platform] : PLATFORMS;
		const now = core.host.now();
		const leases = leaseViews.aliveDevice(store.listLeases(), now, core.host.pidAlive);
		const rows: InventoryEntry[] = [];
		for (const platform of platforms) {
			const inventory = await lh.providerFor(platform, core.owner).inventory();
			if (!inventory.success) {
				core.emit({ kind: "warn", message: `${platform}: skipped (${inventory.error.message})` });
				continue;
			}
			const devices = inventoryMarker.mark(inventory.data, store.listDevices(platform));
			rows.push(...shapes.inventoryRows(devices, platform, leases, params?.booted === true));
		}
		rows.push(...(await new PluginDevices(core).inventory(params)));
		return rows;
	}

	private async capacityOf(params: DevicesListParams | undefined): Promise<CapacityInfo[]> {
		const core = this.core;
		const lh = core.leaseHost();
		const { budget, config } = await new CapacityDepsBuilder(lh).basis();
		const inventory = await new CapacityDepsBuilder(lh).hostInventoryOf(core.owner)();
		const devices = inventory.success ? inventory.data : [];
		const queue = core.store().listQueue();
		const platforms = params?.platform ? [params.platform] : PLATFORMS;
		const bundled = platforms.map((platform) => {
			const running = devices.filter(
				(d) => d.platform === platform && (d.state === "booted" || d.state === "booting")
			).length;
			const max = capacityEnv.enabled(core.host.env)
				? capacityMath.maxConcurrent(platform, budget, config)
				: Number.MAX_SAFE_INTEGER;
			return {
				platform,
				available: Math.max(0, max - running),
				running,
				max,
				queued: queue.filter((q) => q.platform === platform).length,
			};
		});
		return [...bundled, ...(await new PluginDevices(core).capacity(params?.platform))];
	}

	private buildDevices(): DevicesNamespace {
		const core = this.core;
		const windows = new DeviceWindows(core);
		return {
			list: (params, opts) =>
				coreRuntime.guarded(core.signalFor(opts), async () => (await this.inventoryOf(params)).map((e) => e.device)),
			inventory: (params, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.inventoryOf(params)),
			viewer: (opts) => windows.viewer(opts),
			arrange: (params, opts) => windows.arrange(params, opts),
			capacity: (params, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.capacityOf(params)),
		};
	}

	private heartbeatLease(lease: Lease | string): Lease {
		const core = this.core;
		const id = shapes.leaseId(lease);
		const [own] = coreRuntime.ownLeases(core, [id]);
		if (!own) throw new WardenError({ code: "lease_not_found", message: `no lease ${id}` });
		core.store().heartbeat([own.id], core.host.now());
		const fresh = core.store().getLease(own.id);
		if (!fresh) throw new WardenError({ code: "lease_not_found", message: `no lease ${own.id}` });
		return fresh;
	}

	private checkLease(lease: Lease | string): LeaseCheck {
		const core = this.core;
		const found = core.store().getLease(shapes.leaseId(lease));
		if (!found) return { state: "missing" };
		if (!leaseModel.sameOwner(found.owner, core.owner)) {
			throw new WardenError({ code: "lease_foreign", message: `lease ${found.id} is held by someone else` });
		}
		const now = core.host.now();
		if (!liveness.isLeaseAlive(found, now, core.host.pidAlive)) return { state: "stale", lease: found };
		return { state: "held", lease: found, expiresInMs: Math.max(0, found.heartbeatAt + found.ttlMs - now) };
	}

	private buildLeases(): LeasesNamespace {
		const core = this.core;
		return {
			claim: (params, opts) => coreRuntime.claimDevices(core, params, opts),
			list: (params, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => {
					const leases = core.store().listLeases();
					return params?.mine ? leases.filter((l) => leaseModel.sameOwner(l.owner, core.owner)) : leases;
				}),
			heartbeat: (lease, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.heartbeatLease(lease)),
			release: (params: ReleaseParams | undefined, opts) =>
				coreRuntime.guarded(core.signalFor(opts), async (): Promise<ReleaseResult> => {
					const ids = params?.leaseIds ?? [...core.claimed.keys()];
					const leases = coreRuntime.ownLeases(core, ids);
					const outcome = await coreRuntime.releaseLeases(core, leases, params?.shutdown === true);
					return { released: outcome.released, shutdown: outcome.shutdown };
				}),
			check: (lease, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.checkLease(lease)),
		};
	}

	private async claimPort(params: PortClaimParams | undefined): Promise<Lease> {
		const core = this.core;
		const spec = portSpecParser.parse(params?.spec ?? `${DEFAULT_PORT_FROM}:${DEFAULT_PORT_SPAN}`);
		if (!spec.success) throw new WardenError({ code: "usage", message: spec.error });
		const leases = coreRuntime.unwrap(
			await new PortAllocator(core.store()).claim(
				{
					owner: core.owner,
					from: spec.data.from,
					span: spec.data.span,
					count: 1,
					ttlMs: params?.ttlMs ?? DEFAULT_TTL_MS,
					pid: process.pid,
					...(core.options.label !== undefined ? { label: core.options.label } : {}),
				},
				{ now: core.host.now, pidAlive: core.host.pidAlive, isPortFree: (port) => portProbe.isFree(port) }
			)
		);
		const [lease] = leases;
		if (!lease) throw new WardenError({ code: "capacity_exhausted", message: "no free port" });
		core.claimed.set(lease.id, lease);
		core.emit({ kind: "lease:claimed", lease });
		core.heartbeat();
		return lease;
	}

	private releasePort(lease: Lease | string): void {
		const core = this.core;
		const id = shapes.leaseId(lease);
		const result = new PortAllocator(core.store()).release({ by: "lease", ids: [id] }, { onlyOwner: core.owner });
		if (result.denied.length > 0) {
			throw new WardenError({ code: "lease_foreign", message: `port lease ${id} is held by someone else` });
		}
		if (result.missing.length > 0) {
			throw new WardenError({ code: "lease_not_found", message: `no port lease ${id}` });
		}
		for (const released of result.released) {
			core.claimed.delete(released.id);
			core.emit({ kind: "lease:released", leaseId: released.id });
		}
		core.heartbeat();
	}

	private buildPorts(): PortsNamespace {
		const core = this.core;
		return {
			claim: (params: PortClaimParams | undefined, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => this.claimPort(params)),
			release: (lease, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.releasePort(lease)),
		};
	}

	private async ensureApp(params: EnsureAppParams): Promise<EnsuredApp> {
		const core = this.core;
		const device = sessionRuntime.deviceOf(core, params);
		sessionRuntime.requireLease(core, device);
		const options = shapes.ensureOptions(params);
		const host = core.appHost();
		const preparer = new AppPreparer(host, core.seams.appDeps ?? defaultAppDeps);
		const prepared = coreRuntime.unwrap(await preparer.prepare(options, device.platform));
		const bundleId = coreRuntime.unwrap(projectConfig.bundleIdFor(prepared.project.project, device.platform));
		const result = coreRuntime.unwrap(
			await preparer.ensurePrepared(core.owner, device.platform, device.id, options, prepared)
		);
		return {
			bundleId,
			buildKey: result.hash,
			cached: result.source === "cache" || result.source === "installed",
			installed: result.installed,
		};
	}

	private async installApp(params: InstallAppParams, opts: CallOptions | undefined): Promise<void> {
		const core = this.core;
		const device = sessionRuntime.deviceOf(core, params);
		sessionRuntime.requireLease(core, device);
		const argv = installer.installArgv(
			{ platform: device.platform, deviceId: device.id },
			resolve(core.host.cwd, params.path),
			core.host.env
		);
		const res = await core.host.exec(argv, {
			timeoutMs: 10 * 60_000,
			...(core.signalFor(opts) ? { signal: core.signalFor(opts) } : {}),
		});
		if (res.exitCode !== 0 || /Failure \[/.test(res.stdout)) {
			throw new WardenError({
				code: "failed",
				message: `install failed: ${(res.stderr || res.stdout).trim().split("\n")[0] ?? `exit ${res.exitCode}`}`,
				details: { path: params.path, deviceId: device.id },
			});
		}
	}

	private listBuilds(platform: Platform | undefined): BuildInfo[] {
		return new BuildsTable(this.core.store())
			.list()
			.filter((b) => platform === undefined || b.platform === platform)
			.map((b) => ({
				key: shapes.buildKey(b),
				platform: b.platform,
				path: b.path,
				sizeBytes: b.size,
				createdAt: b.createdAt,
			}));
	}

	private pruneBuilds(params: { keep?: number; olderThanMs?: number } | undefined): string[] {
		const core = this.core;
		const store = core.store();
		const now = core.host.now();
		return store.transaction(() => {
			const locked = buildLock.live(store, now, core.host.pidAlive);
			const builds = new BuildsTable(store)
				.list()
				.filter((b) => !prune.isAlias(b) && !locked.has(buildLock.key(b.projectKey, b.platform, b.hash)))
				.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
			const removed = builds.filter(
				(b, index) =>
					(params?.keep !== undefined && index >= params.keep) ||
					(params?.olderThanMs !== undefined && now - b.lastUsedAt > params.olderThanMs)
			);
			for (const b of removed) buildCache.remove(store, core.host.env, b);
			return removed.map((b) => shapes.buildKey(b));
		});
	}

	private buildApps(): AppsNamespace {
		const core = this.core;
		return {
			ensure: (params: EnsureAppParams, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => this.ensureApp(params)),
			install: (params: InstallAppParams, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => this.installApp(params, opts)),
			builds: {
				list: (params, opts) =>
					coreRuntime.guarded(core.signalFor(opts), (): BuildInfo[] => this.listBuilds(params?.platform)),
				prune: (params, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.pruneBuilds(params)),
			},
		};
	}

	/** What `startMetro` needs from the host: who owns a port, the clock, spawning the dev server, Expo and git lookups. */
	private metroDeps(): ConstructorParameters<typeof MetroRunner>[0] {
		const core = this.core;
		return {
			probe: (port, projectRoot) => metroTools.owner(core.host.exec, port, projectRoot),
			now: core.host.now,
			sleep: core.host.sleep,
			spawn: (cmd, env, cwd) => {
				const proc = Bun.spawn(cmd, {
					cwd,
					env: Object.fromEntries(
						Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] !== undefined)
					),
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				return {
					exited: proc.exited,
					kill: (sig) => {
						proc.kill(sig);
					},
				};
			},
			expoBin: (projectRoot) => metroTools.expoBin(projectRoot, (cmd) => Bun.which(cmd)),
			git: (projectRoot) => gitFactsReader.readSync(projectRoot, { cache: core.git }),
		};
	}

	/** Lease one port for Metro (the one asked for, else the first free in the default range) and keep it heartbeated. */
	private async claimMetroPort(port: number | undefined): Promise<Lease> {
		const core = this.core;
		const spec = port !== undefined ? `${port}:1` : `${METRO_FROM}:${DEFAULT_PORT_SPAN}`;
		const range = portSpecParser.parse(spec);
		if (!range.success) throw new WardenError({ code: "usage", message: range.error });
		const leases = coreRuntime.unwrap(
			await new PortAllocator(core.store()).claim(
				{
					owner: core.owner,
					from: range.data.from,
					span: range.data.span,
					count: 1,
					ttlMs: DEFAULT_TTL_MS,
					pid: process.pid,
					label: core.options.label ?? "warden sdk metro",
				},
				{ now: core.host.now, pidAlive: core.host.pidAlive, isPortFree: (free) => portProbe.isFree(free) }
			)
		);
		const portLease = leases[0];
		if (portLease?.resource.kind !== "port") {
			throw new WardenError({ code: "capacity_exhausted", message: "no free port for Metro" });
		}
		core.claimed.set(portLease.id, portLease);
		core.heartbeat();
		return portLease;
	}

	private metroRootOf(project: string | undefined): string {
		return resolve(this.core.host.cwd, project ?? ".");
	}

	private metroStatus(entry: RunningMetro | undefined): MetroStatus {
		return entry
			? { running: true, port: entry.metro.port, url: entry.metro.url, pid: process.pid, project: entry.project }
			: { running: false };
	}

	private releaseMetroPort(portLease: Lease): void {
		const core = this.core;
		new PortAllocator(core.store()).release({ by: "lease", ids: [portLease.id] }, { onlyOwner: core.owner });
		core.claimed.delete(portLease.id);
		core.heartbeat();
	}

	private async stopMetro(root: string): Promise<void> {
		const entry = this.metroRunning.get(root);
		if (!entry) return;
		this.metroRunning.delete(root);
		await entry.metro.stop();
		this.releaseMetroPort(entry.portLease);
	}

	private async startMetro(
		params: MetroStartParams | undefined,
		opts: CallOptions | undefined
	): Promise<ReturnType<ClientShapes["metroStatusOf"]>> {
		const core = this.core;
		const root = this.metroRootOf(params?.project);
		const existing = this.metroRunning.get(root);
		if (existing) return shapes.metroStatusOf(existing.metro.port, existing.metro.url, root);
		const portLease = await this.claimMetroPort(params?.port);
		const signal = core.signalFor(opts);
		const started = await new MetroRunner(this.metroDeps()).start({
			projectRoot: root,
			port: portLease.resource.kind === "port" ? portLease.resource.port : 0,
			env: { ...core.host.env, CI: "1" },
			readyTimeoutMs: METRO_READY_MS,
			aborted: () => signal?.aborted === true,
		});
		if (!started.success) {
			this.releaseMetroPort(portLease);
			throw new WardenError({ code: signal?.aborted ? "interrupted" : "failed", message: started.error });
		}
		this.metroRunning.set(root, { metro: started.data, portLease, project: root });
		return shapes.metroStatusOf(started.data.port, metroTools.url(started.data.port), root);
	}

	private buildMetro(): MetroNamespace {
		const core = this.core;
		core.cleanups.push(async () => {
			for (const root of [...this.metroRunning.keys()]) await this.stopMetro(root);
		});
		return {
			start: (params: MetroStartParams | undefined, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => this.startMetro(params, opts)),
			stop: (params, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () => this.stopMetro(this.metroRootOf(params?.project))),
			status: (params, opts) =>
				coreRuntime.guarded(core.signalFor(opts), () =>
					this.metroStatus(this.metroRunning.get(this.metroRootOf(params?.project)))
				),
		};
	}

	private buildSessions(): SessionsNamespace {
		const core = this.core;
		return {
			open: (params, opts) => sessionRuntime.open(core, params, opts),
			end: (sessionId, opts) =>
				coreRuntime.guarded(core.signalFor(opts), async () => {
					const close = core.sessions.get(sessionId);
					if (!close) {
						throw new WardenError({ code: "not_found", message: `no open session ${sessionId}` });
					}
					await close();
				}),
		};
	}

	/** Close every open session and cleanup, then release what the client claimed (devices it booted are shut down). */
	private async closeEverything(): Promise<unknown[]> {
		const core = this.core;
		const failures: unknown[] = [];
		for (const closeSession of [...core.sessions.values(), ...core.cleanups]) {
			try {
				await closeSession();
			} catch (error) {
				failures.push(error);
			}
		}
		const owned = [...core.claimed.values()];
		core.heartbeat();
		try {
			const booted = owned.filter((l) => l.bootedByOwner === true);
			const rest = owned.filter((l) => l.bootedByOwner !== true);
			if (booted.length > 0) await coreRuntime.releaseLeases(core, booted, true);
			if (rest.length > 0) await coreRuntime.releaseLeases(core, rest, false);
		} catch (error) {
			failures.push(error);
		}
		return failures;
	}
}

/**
 * The typed warden client: devices, leases, ports, apps, Metro and driver sessions over the same engine the CLI
 * uses. Every method takes `{ signal }`, throws a {@link WardenError}, and `await using` (or `close()`) releases what
 * the client claimed. `seams` is for tests.
 */
export function createWardenClient(options: WardenClientOptions = {}, seams: ClientSeams = {}): WardenClient {
	return new WardenClientImpl(options, seams);
}
