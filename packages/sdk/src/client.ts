import { resolve } from "node:path";
import { removeBuild } from "@delacour/warden-builds/cache";
import { bundleIdFor } from "@delacour/warden-builds/config";
import { installArgv } from "@delacour/warden-builds/install";
import { buildLockKey, liveBuildLocks } from "@delacour/warden-builds/lock";
import { type Metro, metroOwner, metroUrl, resolveExpoBin, startMetro } from "@delacour/warden-builds/metro";
import { defaultAppDeps, type EnsureOptions, ensurePreparedApp, prepareApp } from "@delacour/warden-builds/prepare";
import { isAlias } from "@delacour/warden-builds/prune";
import { DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { DEFAULT_PORT_SPAN, parsePortSpec } from "@delacour/warden-config/ports-spec";
import { maxConcurrent } from "@delacour/warden-leasing/capacity";
import { capacityEnabled, hostInventoryOf, readCapacityBasis } from "@delacour/warden-leasing/capacity-deps";
import { markWardenDevices } from "@delacour/warden-leasing/inventory";
import { claimPorts, isPortFree, releasePorts } from "@delacour/warden-leasing/ports";
import { gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { BuildsTable } from "@delacour/warden-store/builds-table";
import { liveness } from "@delacour/warden-store/liveness";
import { type InventoryDevice, type Lease, leaseModel, type Platform } from "@delacour/warden-store/types";
import {
	type ClientSeams,
	type Core,
	claimDevices,
	createCore,
	guarded,
	ownLeases,
	releaseLeases,
	unwrap,
} from "./core";
import { arrangeWindows, viewerOf } from "./device-windows";
import { WardenError } from "./errors";
import { aliveDeviceLeases } from "./lease-view";
import { buildPerf } from "./perf";
import { pluginCapacity, pluginInventory } from "./plugins/plugin-devices";
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
import { deviceOf, openSession, requireLease } from "./session";
import { buildSpecs } from "./specs";

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const DEFAULT_PORT_FROM = 8091;
const METRO_FROM = 8081;
const METRO_READY_MS = 120_000;

const leaseId = (lease: Lease | string): string => (typeof lease === "string" ? lease : lease.id);

function stateOf(device: InventoryDevice): DeviceInfo["state"] {
	return device.state;
}

function deviceInfo(device: InventoryDevice, leased: boolean): DeviceInfo {
	return {
		platform: device.platform,
		id: device.id,
		name: device.name,
		state: stateOf(device),
		wardenCreated: device.wardenCreated,
		...(device.profile !== undefined ? { profile: device.profile } : {}),
		...(device.runtime !== undefined ? { runtime: device.runtime } : {}),
		leased,
		...(device.quarantined ? { quarantined: true } : {}),
	};
}

function buildKey(b: { projectKey: string; platform: Platform; hash: string }): string {
	return `${b.projectKey}:${b.platform}:${b.hash}`;
}

/** Devices (golden images excluded) of the platforms asked for, with the lease holding each. */
async function inventoryOf(core: Core, params: DevicesListParams | undefined): Promise<InventoryEntry[]> {
	const store = core.store();
	const lh = core.leaseHost();
	const platforms = params?.platform ? [params.platform] : PLATFORMS;
	const now = core.host.now();
	const leases = aliveDeviceLeases(store.listLeases(), now, core.host.pidAlive);
	const rows: InventoryEntry[] = [];
	for (const platform of platforms) {
		const inventory = await lh.providerFor(platform, core.owner).inventory();
		if (!inventory.success) {
			core.emit({ kind: "warn", message: `${platform}: skipped (${inventory.error.message})` });
			continue;
		}
		const devices = markWardenDevices(inventory.data, store.listDevices(platform));
		rows.push(...inventoryRows(devices, platform, leases, params?.booted === true));
	}
	rows.push(...(await pluginInventory(core, params)));
	return rows;
}

/** One platform's rows: golden images are left out, `bootedOnly` keeps running devices, each row carries its lease. */
function inventoryRows(
	devices: ReturnType<typeof markWardenDevices>,
	platform: Platform,
	leases: ReturnType<typeof aliveDeviceLeases>,
	bootedOnly: boolean
): InventoryEntry[] {
	return devices
		.filter((device) => !device.golden && !(bootedOnly && device.state !== "booted"))
		.map((device) => {
			const held = leases.get(`${platform}:${device.id}`);
			const lease = held?.provider === undefined ? held : undefined;
			return { device: deviceInfo(device, lease !== undefined), ...(lease ? { lease } : {}) };
		});
}

function buildDevices(core: Core): DevicesNamespace {
	return {
		list: (params, opts) =>
			guarded(core.signalFor(opts), async () => (await inventoryOf(core, params)).map((e) => e.device)),
		inventory: (params, opts) => guarded(core.signalFor(opts), () => inventoryOf(core, params)),
		viewer: (opts) => viewerOf(core, opts),
		arrange: (params, opts) => arrangeWindows(core, params, opts),
		capacity: (params, opts) =>
			guarded(core.signalFor(opts), async (): Promise<CapacityInfo[]> => {
				const lh = core.leaseHost();
				const { budget, config } = await readCapacityBasis(lh);
				const inventory = await hostInventoryOf(lh, core.owner)();
				const devices = inventory.success ? inventory.data : [];
				const queue = core.store().listQueue();
				const platforms = params?.platform ? [params.platform] : PLATFORMS;
				const bundled = platforms.map((platform) => {
					const running = devices.filter(
						(d) => d.platform === platform && (d.state === "booted" || d.state === "booting")
					).length;
					const max = capacityEnabled(core.host.env)
						? maxConcurrent(platform, budget, config)
						: Number.MAX_SAFE_INTEGER;
					return {
						platform,
						available: Math.max(0, max - running),
						running,
						max,
						queued: queue.filter((q) => q.platform === platform).length,
					};
				});
				return [...bundled, ...(await pluginCapacity(core, params?.platform))];
			}),
	};
}

function buildLeases(core: Core): LeasesNamespace {
	return {
		claim: (params, opts) => claimDevices(core, params, opts),
		list: (params, opts) =>
			guarded(core.signalFor(opts), () => {
				const leases = core.store().listLeases();
				return params?.mine ? leases.filter((l) => leaseModel.sameOwner(l.owner, core.owner)) : leases;
			}),
		heartbeat: (lease, opts) =>
			guarded(core.signalFor(opts), () => {
				const [own] = ownLeases(core, [leaseId(lease)]);
				if (!own) throw new WardenError({ code: "lease_not_found", message: `no lease ${leaseId(lease)}` });
				core.store().heartbeat([own.id], core.host.now());
				const fresh = core.store().getLease(own.id);
				if (!fresh) throw new WardenError({ code: "lease_not_found", message: `no lease ${own.id}` });
				return fresh;
			}),
		release: (params: ReleaseParams | undefined, opts) =>
			guarded(core.signalFor(opts), async (): Promise<ReleaseResult> => {
				const ids = params?.leaseIds ?? [...core.claimed.keys()];
				const leases = ownLeases(core, ids);
				const outcome = await releaseLeases(core, leases, params?.shutdown === true);
				return { released: outcome.released, shutdown: outcome.shutdown };
			}),
		check: (lease, opts) =>
			guarded(core.signalFor(opts), (): LeaseCheck => {
				const found = core.store().getLease(leaseId(lease));
				if (!found) return { state: "missing" };
				if (!leaseModel.sameOwner(found.owner, core.owner)) {
					throw new WardenError({ code: "lease_foreign", message: `lease ${found.id} is held by someone else` });
				}
				const now = core.host.now();
				if (!liveness.isLeaseAlive(found, now, core.host.pidAlive)) return { state: "stale", lease: found };
				return { state: "held", lease: found, expiresInMs: Math.max(0, found.heartbeatAt + found.ttlMs - now) };
			}),
	};
}

function buildPorts(core: Core): PortsNamespace {
	return {
		claim: (params: PortClaimParams | undefined, opts) =>
			guarded(core.signalFor(opts), async () => {
				const spec = parsePortSpec(params?.spec ?? `${DEFAULT_PORT_FROM}:${DEFAULT_PORT_SPAN}`);
				if (!spec.success) throw new WardenError({ code: "usage", message: spec.error });
				const leases = unwrap(
					await claimPorts(
						core.store(),
						{
							owner: core.owner,
							from: spec.data.from,
							span: spec.data.span,
							count: 1,
							ttlMs: params?.ttlMs ?? DEFAULT_TTL_MS,
							pid: process.pid,
							...(core.options.label !== undefined ? { label: core.options.label } : {}),
						},
						{ now: core.host.now, pidAlive: core.host.pidAlive, isPortFree: (port) => isPortFree(port) }
					)
				);
				const [lease] = leases;
				if (!lease) throw new WardenError({ code: "capacity_exhausted", message: "no free port" });
				core.claimed.set(lease.id, lease);
				core.emit({ kind: "lease:claimed", lease });
				core.heartbeat();
				return lease;
			}),
		release: (lease, opts) =>
			guarded(core.signalFor(opts), () => {
				const result = releasePorts(core.store(), { by: "lease", ids: [leaseId(lease)] }, { onlyOwner: core.owner });
				if (result.denied.length > 0) {
					throw new WardenError({
						code: "lease_foreign",
						message: `port lease ${leaseId(lease)} is held by someone else`,
					});
				}
				if (result.missing.length > 0) {
					throw new WardenError({ code: "lease_not_found", message: `no port lease ${leaseId(lease)}` });
				}
				for (const released of result.released) {
					core.claimed.delete(released.id);
					core.emit({ kind: "lease:released", leaseId: released.id });
				}
				core.heartbeat();
			}),
	};
}

function ensureOptions(params: EnsureAppParams): EnsureOptions {
	return {
		eas: true,
		build: true,
		...(params.project !== undefined ? { project: params.project } : {}),
		...(params.profile !== undefined ? { variant: params.profile } : {}),
	};
}

function buildApps(core: Core): AppsNamespace {
	return {
		ensure: (params: EnsureAppParams, opts) =>
			guarded(core.signalFor(opts), async (): Promise<EnsuredApp> => {
				const device = deviceOf(core, params);
				requireLease(core, device);
				const options = ensureOptions(params);
				const host = core.appHost();
				const prepared = unwrap(await prepareApp(host, options, device.platform));
				const bundleId = unwrap(bundleIdFor(prepared.project.project, device.platform));
				const result = unwrap(
					await ensurePreparedApp(
						host,
						core.seams.appDeps ?? defaultAppDeps,
						core.owner,
						device.platform,
						device.id,
						options,
						prepared
					)
				);
				return {
					bundleId,
					buildKey: result.hash,
					cached: result.source === "cache" || result.source === "installed",
					installed: result.installed,
				};
			}),
		install: (params: InstallAppParams, opts) =>
			guarded(core.signalFor(opts), async () => {
				const device = deviceOf(core, params);
				requireLease(core, device);
				const argv = installArgv(
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
			}),
		builds: {
			list: (params, opts) =>
				guarded(core.signalFor(opts), (): BuildInfo[] =>
					new BuildsTable(core.store())
						.list()
						.filter((b) => params?.platform === undefined || b.platform === params.platform)
						.map((b) => ({
							key: buildKey(b),
							platform: b.platform,
							path: b.path,
							sizeBytes: b.size,
							createdAt: b.createdAt,
						}))
				),
			prune: (params, opts) =>
				guarded(core.signalFor(opts), () => {
					const store = core.store();
					const now = core.host.now();
					return store.transaction(() => {
						const locked = liveBuildLocks(store, now, core.host.pidAlive);
						const builds = new BuildsTable(store)
							.list()
							.filter((b) => !isAlias(b) && !locked.has(buildLockKey(b.projectKey, b.platform, b.hash)))
							.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
						const removed = builds.filter(
							(b, index) =>
								(params?.keep !== undefined && index >= params.keep) ||
								(params?.olderThanMs !== undefined && now - b.lastUsedAt > params.olderThanMs)
						);
						for (const b of removed) removeBuild(store, core.host.env, b);
						return removed.map(buildKey);
					});
				}),
		},
	};
}

type RunningMetro = { metro: Metro; portLease: Lease; project: string };

/** What `startMetro` needs from the host: who owns a port, the clock, spawning the dev server, Expo and git lookups. */
function metroDeps(core: Core): Parameters<typeof startMetro>[0] {
	return {
		probe: (port, projectRoot) => metroOwner(core.host.exec, port, projectRoot),
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
		expoBin: (projectRoot) => resolveExpoBin(projectRoot, (cmd) => Bun.which(cmd)),
		git: (projectRoot) => gitFactsReader.readSync(projectRoot, { cache: core.git }),
	};
}

/** The `running` answer of `metro.start`. */
function metroStatusOf(port: number, url: string, project: string) {
	return { running: true as const, port, url, pid: process.pid, project };
}

/** Lease one port for Metro (the one asked for, else the first free in the default range) and keep it heartbeated. */
async function claimMetroPort(core: Core, port: number | undefined): Promise<Lease> {
	const spec = port !== undefined ? `${port}:1` : `${METRO_FROM}:${DEFAULT_PORT_SPAN}`;
	const range = parsePortSpec(spec);
	if (!range.success) throw new WardenError({ code: "usage", message: range.error });
	const leases = unwrap(
		await claimPorts(
			core.store(),
			{
				owner: core.owner,
				from: range.data.from,
				span: range.data.span,
				count: 1,
				ttlMs: DEFAULT_TTL_MS,
				pid: process.pid,
				label: core.options.label ?? "warden sdk metro",
			},
			{ now: core.host.now, pidAlive: core.host.pidAlive, isPortFree: (port) => isPortFree(port) }
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

function buildMetro(core: Core): MetroNamespace {
	const running = new Map<string, RunningMetro>();
	const rootOf = (project: string | undefined): string => resolve(core.host.cwd, project ?? ".");
	const status = (entry: RunningMetro | undefined): MetroStatus =>
		entry
			? { running: true, port: entry.metro.port, url: entry.metro.url, pid: process.pid, project: entry.project }
			: { running: false };
	core.cleanups.push(async () => {
		for (const root of [...running.keys()]) await stop(root);
	});
	const stop = async (root: string): Promise<void> => {
		const entry = running.get(root);
		if (!entry) return;
		running.delete(root);
		await entry.metro.stop();
		releasePorts(core.store(), { by: "lease", ids: [entry.portLease.id] }, { onlyOwner: core.owner });
		core.claimed.delete(entry.portLease.id);
		core.heartbeat();
	};
	return {
		start: (params: MetroStartParams | undefined, opts) =>
			guarded(core.signalFor(opts), async () => {
				const root = rootOf(params?.project);
				const existing = running.get(root);
				if (existing) return metroStatusOf(existing.metro.port, existing.metro.url, root);
				const portLease = await claimMetroPort(core, params?.port);
				const signal = core.signalFor(opts);
				const started = await startMetro(metroDeps(core), {
					projectRoot: root,
					port: portLease.resource.kind === "port" ? portLease.resource.port : 0,
					env: { ...core.host.env, CI: "1" },
					readyTimeoutMs: METRO_READY_MS,
					aborted: () => signal?.aborted === true,
				});
				if (!started.success) {
					releasePorts(core.store(), { by: "lease", ids: [portLease.id] }, { onlyOwner: core.owner });
					core.claimed.delete(portLease.id);
					core.heartbeat();
					throw new WardenError({ code: signal?.aborted ? "interrupted" : "failed", message: started.error });
				}
				running.set(root, { metro: started.data, portLease, project: root });
				return metroStatusOf(started.data.port, metroUrl(started.data.port), root);
			}),
		stop: (params, opts) => guarded(core.signalFor(opts), () => stop(rootOf(params?.project))),
		status: (params, opts) => guarded(core.signalFor(opts), () => status(running.get(rootOf(params?.project)))),
	};
}

function buildSessions(core: Core): SessionsNamespace {
	return {
		open: (params, opts) => openSession(core, params, opts),
		end: (sessionId, opts) =>
			guarded(core.signalFor(opts), async () => {
				const close = core.sessions.get(sessionId);
				if (!close) {
					throw new WardenError({ code: "not_found", message: `no open session ${sessionId}` });
				}
				await close();
			}),
	};
}

/** Close every open session and cleanup, then release what the client claimed (devices it booted are shut down). */
async function closeEverything(core: Core): Promise<unknown[]> {
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
		if (booted.length > 0) await releaseLeases(core, booted, true);
		if (rest.length > 0) await releaseLeases(core, rest, false);
	} catch (error) {
		failures.push(error);
	}
	return failures;
}

/**
 * The typed warden client: devices, leases, ports, apps, Metro and driver sessions over the same engine the CLI
 * uses. Every method takes `{ signal }`, throws a {@link WardenError}, and `await using` (or `close()`) releases what
 * the client claimed. `seams` is for tests.
 */
export function createWardenClient(options: WardenClientOptions = {}, seams: ClientSeams = {}): WardenClient {
	const core = createCore(options, seams);
	const close = async (opts?: CallOptions): Promise<void> => {
		if (core.closed) return;
		core.closed = true;
		const failures = await closeEverything(core);
		core.closeStore();
		const first = failures[0];
		if (first !== undefined && opts?.signal?.aborted !== true)
			throw first instanceof WardenError ? first : new WardenError({ code: "failed", message: String(first) });
	};
	return {
		devices: buildDevices(core),
		leases: buildLeases(core),
		ports: buildPorts(core),
		apps: buildApps(core),
		metro: buildMetro(core),
		sessions: buildSessions(core),
		specs: buildSpecs(core),
		perf: buildPerf(core),
		on: core.on,
		off: core.off,
		close,
		[Symbol.asyncDispose]: () => close(),
	};
}
