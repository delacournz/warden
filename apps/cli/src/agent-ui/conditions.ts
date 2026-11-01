import { resolve } from "node:path";
import type {
	ClockCondition,
	ConditionRecord,
	HostFault,
	LocationCondition,
	NetworkCondition,
	OwnedProcess,
} from "@delacour/warden-config/conditions.types";
import { durationParser } from "@delacour/warden-config/duration";
import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import type { SchedulerConfig } from "@delacour/warden-device/conditions/scheduler.config";
import type { ClockState, NetworkState } from "@delacour/warden-driver/driver.types";
import { physicalConditions } from "@delacour/warden-driver/physical-conditions";
import { liveness } from "@delacour/warden-store/liveness";
import { processIdentity } from "@delacour/warden-store/process-identity";
import type { Lease } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { NETPROXY_SUBCOMMAND } from "../e2e/bun-runner";
import { selfCommandHelpers } from "../self-command";
import { uiConditionText } from "./condition-text";
import { type FlapFlags, type FlapSpec, type ShapingFlags, uiConditionsParse } from "./conditions-parse";
import type { ConditionsDeps, ConditionsPort } from "./conditions-types";
import { type UiDevice, uiDeviceResolver } from "./device";
import { opErrors, type UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiOutput } from "./output";
import { type UiOptionValues, type UiRunEnv, uiRun } from "./run";
import { uiStatePersistence } from "./state";

/** Flags of `warden ui net`; `--up` / `--down` / `--jitter` mean kbps / kbps / ms for a condition and duration / duration / percent for `flap`. */
export type NetOptionValues = UiOptionValues & ShapingFlags & FlapFlags & { relaunch?: true; clear?: true };

export type LocationOptionValues = UiOptionValues & {
	alt?: string;
	speed?: string;
	interval?: string;
	loop?: true;
};

/** How long a stopped scheduler / ticker gets to exit (a flap puts its base back first). */
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;

const SCHEDULER_MARK = ["scheduler"] as const;
const TICKER_MARK = ["route-ticker"] as const;

const NET_WORDS = new Set(["flap", "fault", "status", "reset"]);

type LocationEnv = { ctx: CommandContext; env: UiRunEnv; deps: Required<ConditionsDeps>; device: UiDevice };

export type ClockOptionValues = UiOptionValues & { frozen?: true; relaunch?: true };

const LARGE_OFFSET_MS = 86_400_000;

export class UiConditions {
	fail(
		code: Parameters<typeof uiOutput.uiError>[0],
		message: string,
		hint?: string
	): { success: false; error: UiError } {
		return {
			success: false,
			error: uiOutput.uiError(code, message, hint === undefined ? {} : { hint }),
		};
	}

	async resolveDeps(deps: UiDeps): Promise<Required<ConditionsDeps>> {
		const { realConditionsDeps } = await import("./conditions-real");
		return { ...realConditionsDeps, ...deps.conditions } as Required<ConditionsDeps>;
	}

	/** The options a network op takes: the app `warden ui open` launched (a fresh process has launched none) and `--relaunch`. */
	private networkOptions(ctx: CommandContext, device: UiDevice, opts: NetOptionValues) {
		const bundleId = device.platform === "ios" ? uiStatePersistence.readState(ctx, device.udid).app : undefined;
		return {
			...(bundleId === undefined ? {} : { bundleId }),
			...(opts.relaunch ? { relaunch: true } : {}),
		};
	}

	deviceInfo(device: UiDevice) {
		return { udid: device.udid, platform: device.platform, name: device.name };
	}

	recordOf<A extends ConditionRecord["area"]>(
		ctx: CommandContext,
		leaseId: string,
		area: A
	): Extract<ConditionRecord, { area: A }> | undefined {
		return leaseConditions
			.active(ctx.store(), leaseId)
			.find((record): record is Extract<ConditionRecord, { area: A }> => record.area === area);
	}

	/** SIGTERM the processes `record` owns (but `keep`) that still look like ours, and wait for them to exit. */
	private async stopOwned(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		record: ConditionRecord | undefined,
		marks: readonly string[],
		keep?: number
	): Promise<void> {
		const alive = env.deps.pidAlive ?? liveness.processAlive;
		const identity = { pidAlive: alive, command: deps.command };
		const pids = (record?.owned ?? []).map((p) => p.pid).filter((pid) => pid !== keep);
		const stopped: number[] = [];
		for (const pid of pids) {
			if (processIdentity.recordedIdentity(identity, pid, marks) !== "match") continue;
			try {
				deps.kill(pid);
				stopped.push(pid);
			} catch {
				// gone between the check and the signal
			}
		}
		const until = ctx.now() + STOP_WAIT_MS;
		while (stopped.some((pid) => alive(pid)) && ctx.now() < until) await env.deps.sleep(STOP_POLL_MS);
	}

	private ownedPids(deps: Required<ConditionsDeps>, ctx: CommandContext, lease: Lease, extra: readonly OwnedProcess[]) {
		const proxy = deps.proxyPid(ctx, lease.id);
		return [...(proxy === undefined ? [] : [{ kind: "pid" as const, pid: proxy }]), ...extra];
	}

	/** Runs `work` on the device's condition port; a physical device gets the refusing ops and is never opened. */
	async withPort<T>(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		work: (port: ConditionsPort) => Promise<Result<T, UiError>>
	): Promise<Result<T, UiError>> {
		if (uiDeviceResolver.physicalDevice(device)) {
			const what = device.platform === "ios" ? "physical iPhone" : "physical Android device";
			return work({ ...physicalConditions.ops(`${what} ${device.udid}`), close: async () => undefined });
		}
		const port = await deps.open(ctx, device);
		if (!port.success) return port;
		try {
			return await work(port.data);
		} finally {
			await port.data.close().catch(() => undefined);
		}
	}

	/** `E_NETWORK_RELAUNCH` while re-seeding a port from the recorded state only says the app lacks the dylib; the real op reports it. */
	private seedFailure(
		result: Awaited<ReturnType<ConditionsPort["network" | "networkFaults"]>>
	): { success: false; error: UiError } | undefined {
		if (result.success || result.error.code === "E_NETWORK_RELAUNCH") return undefined;
		return { success: false, error: opErrors.driverError(result.error) };
	}

	private readonly faultText = (fault: HostFault): string => {
		const a = fault.action;
		const what =
			a.kind === "status" ? `status ${a.code}` : a.kind === "delay" ? `delay ${durationParser.format(a.ms)}` : a.kind;
		return `${fault.match} → ${what}`;
	};

	private networkSuccess(
		device: UiDevice,
		action: string,
		condition: NetworkCondition,
		state: NetworkState | undefined,
		extra: { warnings?: string[]; result?: Record<string, unknown> } = {}
	): UiSuccess {
		const staged = state?.appliesOnLaunch === true;
		const warnings = [
			...(extra.warnings ?? []),
			...(staged ? ["staged: no running app carries the network dylib; it applies from the next launch"] : []),
			...((state?.needsProxy ?? []).length > 0
				? [`${(state?.needsProxy ?? []).join(", ")} not applied: it needs the shaping proxy`]
				: []),
		];
		return {
			device: this.deviceInfo(device),
			result: {
				action,
				condition,
				...(state === undefined ? {} : { online: state.online, needsProxy: state.needsProxy, staged }),
				...extra.result,
			},
			text: `network ${uiConditionText.describeNetwork(condition)}${state?.online === false ? " (device offline)" : ""}`,
			...(warnings.length > 0 ? { warnings } : {}),
		};
	}

	/** Whether recording `online` as a first condition is worth a row: only when something else already holds the lease's network. */
	private worthRecording(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		lease: Lease,
		condition: NetworkCondition
	) {
		return (
			condition.kind !== "online" ||
			this.recordOf(ctx, lease.id, "network") !== undefined ||
			deps.proxyPid(ctx, lease.id) !== undefined
		);
	}

	private record<A extends "network" | "location">(
		ctx: CommandContext,
		lease: Lease,
		area: A,
		value: A extends "network" ? NetworkCondition : LocationCondition,
		owned: readonly OwnedProcess[]
	): Result<undefined, UiError> {
		const saved = leaseConditions.record(ctx.store(), lease.id, area, value as never, ctx.now(), owned);
		return saved.success
			? resultFactory.ok(undefined)
			: this.fail("failed", `could not record the ${area} condition: ${saved.error}`);
	}

	private async setNetwork(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		condition: NetworkCondition,
		opts: NetOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		await this.stopOwned(
			ctx,
			env,
			deps,
			this.recordOf(ctx, lease.id, "network"),
			SCHEDULER_MARK,
			deps.proxyPid(ctx, lease.id)
		);
		const live = await deps.proxyStatus(ctx, lease.id);
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			if (live && live.faults.length > 0) {
				const seeded = this.seedFailure(await port.networkFaults(live.faults));
				if (seeded) return seeded;
			}
			const applied = opErrors.fromDriver(await port.network(condition, this.networkOptions(ctx, device, opts)));
			if (!applied.success) return applied;
			if (this.worthRecording(ctx, deps, lease, condition)) {
				const saved = this.record(ctx, lease, "network", condition, this.ownedPids(deps, ctx, lease, []));
				if (!saved.success) return saved;
			}
			return resultFactory.ok(this.networkSuccess(device, "net", condition, applied.data));
		});
	}

	private schedulerConfig(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		flap: FlapSpec,
		base: NetworkCondition
	): SchedulerConfig {
		const { lease } = device;
		const bundleId = uiStatePersistence.readState(ctx, device.udid).app;
		const proxyCommand = selfCommandHelpers.compiledSubcommand(NETPROXY_SUBCOMMAND);
		return {
			platform: device.platform,
			id: device.udid,
			mode: "flap",
			flap: {
				upMs: flap.upMs,
				downMs: flap.downMs,
				base,
				applyInitial: false,
				...(flap.jitterPct === undefined ? {} : { jitterPct: flap.jitterPct }),
				...(flap.seed === undefined ? {} : { seed: flap.seed }),
			},
			...(device.platform === "android" ? { adb: deps.adb(ctx) } : {}),
			...(device.platform === "ios"
				? {
						lease: { id: lease.id, owner: lease.owner, ttlMs: lease.ttlMs },
						...(bundleId === undefined ? {} : { bundleId }),
						...(proxyCommand === undefined ? {} : { proxyCommand }),
					}
				: {}),
		};
	}

	private async flapNetwork(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		opts: NetOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const flap = uiConditionsParse.parseFlap(opts);
		if (!flap.success) return flap;
		const { lease } = device;
		const live = await deps.proxyStatus(ctx, lease.id);
		if (live && live.faults.length > 0) {
			return this.fail(
				"failed",
				"faults are set; a flap would replace them",
				"run `warden ui net fault --clear` first"
			);
		}
		await this.stopOwned(
			ctx,
			env,
			deps,
			this.recordOf(ctx, lease.id, "network"),
			SCHEDULER_MARK,
			deps.proxyPid(ctx, lease.id)
		);
		const base: NetworkCondition = { kind: "online" };
		const applied = await this.withPort<NetworkState>(ctx, deps, device, async (port) =>
			opErrors.fromDriver(await port.network(base, this.networkOptions(ctx, device, opts)))
		);
		if (!applied.success) return applied;
		if (device.platform === "ios") {
			const proxy = await deps.ensureProxy(ctx, lease);
			if (!proxy.success) return this.fail("failed", proxy.error);
		}
		const started = deps.spawnScheduler(this.schedulerConfig(ctx, deps, device, flap.data, base));
		if (!started.success) return this.fail("failed", started.error);
		const condition: NetworkCondition = {
			kind: "flap",
			upMs: flap.data.upMs,
			downMs: flap.data.downMs,
			base,
			...(flap.data.jitterPct === undefined ? {} : { jitterPct: flap.data.jitterPct }),
		};
		const saved = this.record(ctx, lease, "network", condition, this.ownedPids(deps, ctx, lease, [started.data]));
		if (!saved.success) {
			deps.kill(started.data.pid);
			return saved;
		}
		return resultFactory.ok({
			...this.networkSuccess(device, "net-flap", condition, applied.data, {
				result: { pid: started.data.pid, seed: flap.data.seed ?? null },
			}),
			text: `network ${uiConditionText.describeNetwork(condition)} (scheduler pid ${started.data.pid})`,
		});
	}

	/** The rules after adding `fault` (same glob replaces). */
	private withFault(current: readonly HostFault[], fault: HostFault): HostFault[] {
		return [...current.filter((existing) => existing.match !== fault.match), fault];
	}

	private async faultNetwork(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		args: readonly string[],
		opts: NetOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		const stored = this.recordOf(ctx, lease.id, "network");
		const live = await deps.proxyStatus(ctx, lease.id);
		let rules: HostFault[];
		if (opts.clear) {
			if (args.length > 0) return this.fail("usage", "--clear takes no host or rule");
			rules = [];
		} else {
			const [match, rule, ...extra] = args;
			if (match === undefined || rule === undefined || extra.length > 0) {
				return this.fail(
					"usage",
					"fault needs <host-glob> <rule>, or --clear",
					"warden ui net fault 'api.*' status:503"
				);
			}
			const fault = uiConditionsParse.parseFault(match, rule);
			if (!fault.success) return fault;
			rules = this.withFault(live?.faults ?? [], fault.data);
		}
		if (stored?.value.kind === "flap") {
			return this.fail(
				"failed",
				"a flap is running; faults would be replaced at its next step",
				"run `warden ui net reset` first"
			);
		}
		if (rules.length === 0 && (live?.faults.length ?? 0) === 0) {
			return resultFactory.ok({
				device: this.deviceInfo(device),
				result: { action: "net-fault", faults: [] },
				text: "no faults set",
			});
		}
		const condition: NetworkCondition = stored?.value ?? { kind: "online" };
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			if (condition.kind !== "online") {
				const seeded = this.seedFailure(
					await port.network(condition, this.networkOptions(ctx, device, {} as NetOptionValues))
				);
				if (seeded) return seeded;
			}
			const applied = opErrors.fromDriver(await port.networkFaults(rules));
			if (!applied.success) return applied;
			const saved = this.record(ctx, lease, "network", condition, this.ownedPids(deps, ctx, lease, []));
			if (!saved.success) return saved;
			return resultFactory.ok({
				device: this.deviceInfo(device),
				result: { action: "net-fault", faults: rules, notes: applied.data.notes },
				text: rules.length === 0 ? "faults cleared" : rules.map(this.faultText).join("\n"),
				...(applied.data.notes.length > 0 ? { warnings: [...applied.data.notes] } : {}),
			});
		});
	}

	private async resetNetwork(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		opts: NetOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		const stored = this.recordOf(ctx, lease.id, "network");
		const live = await deps.proxyStatus(ctx, lease.id);
		if (stored === undefined && live === undefined) {
			return resultFactory.ok({
				device: this.deviceInfo(device),
				result: { action: "net-reset", changed: false },
				text: "network was not changed",
			});
		}
		await this.stopOwned(ctx, env, deps, stored, SCHEDULER_MARK, deps.proxyPid(ctx, lease.id));
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			if ((live?.faults.length ?? 0) > 0) {
				const cleared = this.seedFailure(await port.networkFaults([]));
				if (cleared) return cleared;
			}
			const applied = opErrors.fromDriver(
				await port.network({ kind: "online" }, this.networkOptions(ctx, device, opts))
			);
			if (!applied.success) return applied;
			// the proxy stays up (an injected app still routes through it) until the lease is released
			const saved = this.record(ctx, lease, "network", { kind: "online" }, this.ownedPids(deps, ctx, lease, []));
			if (!saved.success) return saved;
			return resultFactory.ok(
				this.networkSuccess(device, "net-reset", { kind: "online" }, applied.data, { result: { changed: true } })
			);
		});
	}

	private async networkStatus(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		const stored = this.recordOf(ctx, lease.id, "network");
		const live = await deps.proxyStatus(ctx, lease.id);
		const alive = env.deps.pidAlive ?? liveness.processAlive;
		const proxyPid = deps.proxyPid(ctx, lease.id);
		const flapPid =
			stored?.value.kind === "flap" ? stored.owned.map((p) => p.pid).find((pid) => pid !== proxyPid) : undefined;
		const flap = flapPid === undefined ? null : { pid: flapPid, running: alive(flapPid) };
		const faults = live?.faults ?? [];
		const lines = [
			`network   ${stored === undefined ? "not set (online)" : uiConditionText.describeNetwork(stored.value)}`,
			...(flap ? [`flap      ${flap.running ? "running" : "NOT running"} (pid ${flap.pid})`] : []),
			...(faults.length > 0
				? faults.map((f, i) => `${i === 0 ? "faults    " : "          "}${this.faultText(f)}`)
				: []),
			...(live
				? [
						`proxy     :${live.port} ${live.stats.connections} connections, ${live.stats.faulted} faulted, ${live.stats.resets} reset`,
					]
				: []),
		];
		return resultFactory.ok({
			device: this.deviceInfo(device),
			result: {
				action: "net-status",
				condition: stored?.value ?? null,
				setAt: stored?.setAt ?? null,
				faults,
				flap,
				proxy: live ? { port: live.port, pid: live.pid, stats: live.stats } : null,
			},
			text: lines.join("\n"),
		});
	}

	/**
	 * `warden ui net <online|offline|edge|3g|4g|lte|wifi|slow|lossy> [shaping flags]` · `net flap --up 10s --down 3s` ·
	 * `net fault <host-glob> <rule>` · `net fault --clear` · `net status` · `net reset`. Each change is recorded on the
	 * caller's lease (`recordCondition`), so release / gc undo it and stop what it started.
	 */
	uiNet(
		ctx: CommandContext,
		deps: UiDeps,
		action: string,
		rest: readonly string[],
		opts: NetOptionValues
	): Promise<number> {
		const label = NET_WORDS.has(action) ? `net ${action}` : "net";
		return uiRun.runUi(ctx, deps, label, opts, async (device, env) => {
			const real = await this.resolveDeps(deps);
			switch (action) {
				case "flap":
					return this.flapNetwork(ctx, env, real, device, opts);
				case "fault":
					return this.faultNetwork(ctx, real, device, rest, opts);
				case "status":
					return this.networkStatus(ctx, env, real, device);
				case "reset":
					return this.resetNetwork(ctx, env, real, device, opts);
				default: {
					if (rest.length > 0) return this.fail("usage", `unexpected argument "${rest[0]}" after ${action}`);
					const condition = uiConditionsParse.parseNetworkCondition(action, opts);
					if (!condition.success) return condition;
					return this.setNetwork(ctx, env, real, device, condition.data, opts);
				}
			}
		});
	}

	/** `warden ui network set <condition>`: a condition word only (`flap` / `fault` / `status` / `reset` are their own subcommands). */
	uiNetSet(ctx: CommandContext, deps: UiDeps, word: string, opts: NetOptionValues): Promise<number> {
		if (!NET_WORDS.has(word)) return this.uiNet(ctx, deps, word, [], opts);
		return uiRun.runUi(ctx, deps, "net", opts, async () =>
			this.fail("usage", `"${word}" is not a condition: use \`warden ui network ${word}\``)
		);
	}

	private locationSuccess(
		device: UiDevice,
		action: string,
		value: LocationCondition,
		extra: Record<string, unknown> = {}
	) {
		return resultFactory.ok<UiSuccess>({
			device: this.deviceInfo(device),
			result: { action, location: value, ...extra },
			text: `location ${uiConditionText.describeLocation(value)}`,
		});
	}

	/** Android: the ticker plays moving locations (the emulator console has no player); iOS hands them to simctl. */
	private readonly moveLocation = async (
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		action: string,
		value: Extract<LocationCondition, { kind: "route" | "gpx" | "scenario" }>
	): Promise<Result<UiSuccess, UiError>> => {
		const { lease } = device;
		await this.stopOwned(ctx, env, deps, this.recordOf(ctx, lease.id, "location"), TICKER_MARK);
		if (device.platform === "ios") {
			return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
				const played = opErrors.fromDriver(await port.location(value));
				if (!played.success) return played;
				const saved = this.record(ctx, lease, "location", value, []);
				return saved.success ? this.locationSuccess(device, action, value) : saved;
			});
		}
		const { locationPlanner } = await import("@delacour/warden-driver/conditions/location-plan");
		const { readFile } = await import("node:fs/promises");
		const planned = await locationPlanner.planRoute(value, (path) => readFile(path, "utf8"));
		if (!planned.success) return this.fail("usage", planned.error);
		const plan = planned.data;
		const placed = await this.withPort<void>(ctx, deps, device, async (port) => {
			const first = plan.points[0];
			return first === undefined
				? this.fail("usage", "a route needs at least one point")
				: opErrors.fromDriver(await port.location({ kind: "point", lat: first.lat, lon: first.lon }));
		});
		if (!placed.success) return placed;
		if (plan.points.length < 2) {
			const point = plan.points[0] as { lat: number; lon: number };
			const saved = this.record(ctx, lease, "location", { kind: "point", ...point }, []);
			return saved.success ? this.locationSuccess(device, action, value) : saved;
		}
		const started = deps.spawnTicker({
			adb: deps.adb(ctx),
			serial: device.udid,
			points: plan.points,
			speedMps: plan.speedMps,
			intervalS: plan.intervalS,
			loop: plan.loop,
		});
		if (!started.success) return this.fail("failed", started.error);
		const saved = this.record(ctx, lease, "location", value, [started.data]);
		if (!saved.success) {
			deps.kill(started.data.pid);
			return saved;
		}
		return this.locationSuccess(device, action, value, {
			pid: started.data.pid,
			points: plan.points.length,
			speedMps: plan.speedMps,
			intervalS: plan.intervalS,
			loop: plan.loop,
		});
	};

	private async setPoint(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		point: { lat: number; lon: number },
		alt: string | undefined
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		let altM: number | undefined;
		if (alt !== undefined) {
			altM = Number(alt);
			if (!Number.isFinite(altM)) return this.fail("usage", `--alt must be a number of metres, got "${alt}"`);
		}
		await this.stopOwned(ctx, env, deps, this.recordOf(ctx, lease.id, "location"), TICKER_MARK);
		const value: LocationCondition = { kind: "point", ...point, ...(altM === undefined ? {} : { altM }) };
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const placed = opErrors.fromDriver(await port.location(value));
			if (!placed.success) return placed;
			const saved = this.record(ctx, lease, "location", value, []);
			return saved.success ? this.locationSuccess(device, "location-set", value) : saved;
		});
	}

	private async clearLocation(
		ctx: CommandContext,
		env: UiRunEnv,
		deps: Required<ConditionsDeps>,
		device: UiDevice
	): Promise<Result<UiSuccess, UiError>> {
		const { lease } = device;
		const stored = this.recordOf(ctx, lease.id, "location");
		await this.stopOwned(ctx, env, deps, stored, TICKER_MARK);
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const cleared = opErrors.fromDriver(await port.location({ kind: "clear" }));
			if (!cleared.success) return cleared;
			leaseConditions.clear(ctx.store(), lease.id, "location");
			return resultFactory.ok<UiSuccess>({
				device: this.deviceInfo(device),
				result: { action: "location-clear", cleared: true, keepsLastFix: device.platform === "android" },
				text: device.platform === "android" ? "location cleared (the emulator keeps its last fix)" : "location cleared",
				...(device.platform === "android"
					? { warnings: ["the emulator console cannot unset a fix: it keeps the last one"] }
					: {}),
			});
		});
	}

	private locationStatus(ctx: CommandContext, env: UiRunEnv, device: UiDevice): Result<UiSuccess, UiError> {
		const stored = this.recordOf(ctx, device.lease.id, "location");
		const alive = env.deps.pidAlive ?? liveness.processAlive;
		const pid = stored?.owned[0]?.pid;
		const ticker = pid === undefined ? null : { pid, running: alive(pid) };
		const line = stored === undefined ? "not set" : uiConditionText.describeLocation(stored.value);
		return resultFactory.ok({
			device: this.deviceInfo(device),
			result: { action: "location-status", location: stored?.value ?? null, setAt: stored?.setAt ?? null, ticker },
			text: `location  ${line}${ticker ? ` (ticker ${ticker.running ? "running" : "NOT running"}, pid ${ticker.pid})` : ""}`,
		});
	}

	private routeValue(
		rest: readonly string[],
		pace: { speedMps?: number },
		intervalS: number | undefined,
		loop: boolean
	): Result<Extract<LocationCondition, { kind: "route" }>, UiError> {
		const points = uiConditionsParse.parseLatLons(rest);
		if (!points.success) return points;
		if (points.data.length === 0) return this.fail("usage", "location route needs at least one <lat,lon>");
		return resultFactory.ok({
			kind: "route",
			points: points.data,
			...pace,
			...(intervalS === undefined ? {} : { intervalS }),
			...(loop ? { loop: true } : {}),
		});
	}

	/** `route` / `gpx` / `scenario`: parse the arguments, then hand the moving location to {@link moveLocation}. */
	private movingLocation(
		at: LocationEnv,
		action: "route" | "gpx" | "scenario",
		rest: readonly string[],
		opts: LocationOptionValues
	): Promise<Result<UiSuccess, UiError>> | Result<UiSuccess, UiError> {
		const speed = uiConditionsParse.parsePositive(opts.speed, "--speed");
		if (!speed.success) return speed;
		const interval = uiConditionsParse.parsePositive(opts.interval, "--interval");
		if (!interval.success) return interval;
		const pace = speed.data === undefined ? {} : { speedMps: speed.data };
		const move = (value: Parameters<typeof this.moveLocation>[5]) =>
			this.moveLocation(at.ctx, at.env, at.deps, at.device, `location-${action}`, value);
		if (action === "route") {
			const route = this.routeValue(rest, pace, interval.data, opts.loop === true);
			return route.success ? move(route.data) : route;
		}
		const [first, ...extra] = rest;
		if (action === "gpx") {
			if (first === undefined || extra.length > 0) return this.fail("usage", "location gpx needs one <file>");
			return move({ kind: "gpx", path: resolve(at.ctx.cwd, first), ...pace });
		}
		const scenario = uiConditionsParse.parseScenario(first ?? "");
		if (!scenario.success) return scenario;
		return extra.length > 0
			? this.fail("usage", "location scenario takes one name")
			: move({ kind: "scenario", name: scenario.data });
	}

	/**
	 * `warden ui location set <lat,lon> [--alt m]` · `route <lat,lon>... [--speed m/s] [--interval s] [--loop]` ·
	 * `gpx <file> [--speed m/s]` · `scenario <city-run|city-bike|freeway>` · `clear` · `status`. Recorded on the caller's
	 * lease; an Android route / gpx / scenario runs as a detached ticker the lease owns.
	 */
	uiLocation(
		ctx: CommandContext,
		deps: UiDeps,
		action: string,
		rest: readonly string[],
		opts: LocationOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, `location ${action}`, opts, async (device, env) => {
			const real = await this.resolveDeps(deps);
			const at: LocationEnv = { ctx, env, deps: real, device };
			switch (action) {
				case "set": {
					const [raw, ...extra] = rest;
					if (raw === undefined || extra.length > 0) return this.fail("usage", "location set needs one <lat,lon>");
					const point = uiConditionsParse.parseLatLon(raw);
					return point.success ? this.setPoint(ctx, env, real, device, point.data, opts.alt) : point;
				}
				case "route":
				case "gpx":
				case "scenario":
					return this.movingLocation(at, action, rest, opts);
				case "clear":
					return this.clearLocation(ctx, env, real, device);
				case "status":
					return this.locationStatus(ctx, env, device);
				default:
					return this.fail(
						"usage",
						`unknown location action "${action}"`,
						"set, route, gpx, scenario, clear or status"
					);
			}
		});
	}

	/** The wall-clock shift a recorded clock means now: `fixed` runs on from when it was set, `frozen` holds. */
	private readonly recordedClock = (record: Extract<ConditionRecord, { area: "clock" }> | undefined, now: number) => {
		const value: ClockCondition = record?.value ?? { kind: "real" };
		switch (value.kind) {
			case "real":
				return { condition: value, offsetMs: 0, frozen: false, nowMs: now };
			case "offset":
				return { condition: value, offsetMs: value.ms, frozen: false, nowMs: now + value.ms };
			case "fixed": {
				const offsetMs = Date.parse(value.at) - (record?.setAt ?? now);
				return { condition: value, offsetMs, frozen: false, nowMs: now + offsetMs };
			}
			case "frozen":
				return { condition: value, offsetMs: 0, frozen: true, nowMs: Date.parse(value.at) };
		}
	};

	private describeClock(state: ReturnType<typeof this.recordedClock>): string {
		const at = new Date(state.nowMs).toISOString();
		if (state.condition.kind === "real") return "clock real";
		return `clock ${state.frozen ? "frozen at" : "now"} ${at}${state.frozen ? "" : ` (offset ${state.offsetMs >= 0 ? "+" : "-"}${durationParser.format(Math.abs(state.offsetMs))})`}`;
	}

	private clockWarnings(offsetMs: number, state?: ClockState): string[] {
		return [
			...(Math.abs(offsetMs) >= LARGE_OFFSET_MS
				? ["a large clock offset breaks HTTPS: certificates fail once the clock passes their dates"]
				: []),
			...(state?.appliesOnLaunch ? ["staged: no running app carries the dylib; it applies from the next launch"] : []),
		];
	}

	private async applyClock(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		action: string,
		condition: ClockCondition,
		opts: ClockOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		return this.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(
				await port.clock(condition, this.networkOptions(ctx, device, opts as NetOptionValues))
			);
			if (!applied.success) return applied;
			if (condition.kind === "real") leaseConditions.clear(ctx.store(), device.lease.id, "clock");
			else {
				const saved = leaseConditions.record(ctx.store(), device.lease.id, "clock", condition, ctx.now());
				if (!saved.success) return this.fail("failed", `could not record the clock condition: ${saved.error}`);
			}
			const state = applied.data;
			return resultFactory.ok({
				device: this.deviceInfo(device),
				result: {
					action,
					condition,
					offsetMs: state.offsetMs,
					frozen: state.frozen,
					nowMs: state.nowMs,
					staged: state.appliesOnLaunch === true,
				},
				text:
					condition.kind === "real"
						? "clock real"
						: `clock ${state.frozen ? "frozen at" : "now"} ${new Date(state.nowMs).toISOString()}`,
				...(this.clockWarnings(state.offsetMs, state).length > 0
					? { warnings: this.clockWarnings(state.offsetMs, state) }
					: {}),
			});
		});
	}

	/** `advance <dur>`: from what is recorded (an offset adds, frozen moves its instant, none starts an offset). */
	private advancedClock(
		ctx: CommandContext,
		record: Extract<ConditionRecord, { area: "clock" }> | undefined,
		by: number
	): ClockCondition {
		const now = this.recordedClock(record, ctx.now());
		if (now.frozen) return { kind: "frozen", at: new Date(now.nowMs + by).toISOString() };
		return { kind: "offset", ms: now.offsetMs + by };
	}

	private clockSet(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		arg: string | undefined,
		opts: ClockOptionValues
	) {
		const at = arg === undefined ? Number.NaN : Date.parse(arg);
		if (Number.isNaN(at)) {
			return this.fail("usage", `clock set needs an ISO 8601 time, got "${arg ?? ""}"`, "2026-01-31T09:00:00Z");
		}
		const condition: ClockCondition = { kind: opts.frozen ? "frozen" : "fixed", at: new Date(at).toISOString() };
		return this.applyClock(ctx, deps, device, "clock-set", condition, opts);
	}

	private clockReset(
		ctx: CommandContext,
		deps: Required<ConditionsDeps>,
		device: UiDevice,
		record: Extract<ConditionRecord, { area: "clock" }> | undefined,
		opts: ClockOptionValues
	) {
		if (record === undefined) {
			return resultFactory.ok<UiSuccess>({
				device: this.deviceInfo(device),
				result: { action: "clock-reset", changed: false },
				text: "clock was not changed",
			});
		}
		return this.applyClock(ctx, deps, device, "clock-reset", { kind: "real" }, opts);
	}

	private clockStatus(
		ctx: CommandContext,
		device: UiDevice,
		record: Extract<ConditionRecord, { area: "clock" }> | undefined
	) {
		const state = this.recordedClock(record, ctx.now());
		const warnings = this.clockWarnings(state.offsetMs);
		return resultFactory.ok<UiSuccess>({
			device: this.deviceInfo(device),
			result: { action: "clock-status", ...state, setAt: record?.setAt ?? null },
			text: this.describeClock(state),
			...(warnings.length > 0 ? { warnings } : {}),
		});
	}

	/**
	 * `warden ui clock set <iso> [--frozen]` · `advance <dur>` · `status` · `reset [--relaunch]`. Wall clock only
	 * (monotonic clocks never move). Recorded on the caller's lease; release / gc put the clock back.
	 */
	uiClock(
		ctx: CommandContext,
		deps: UiDeps,
		action: string,
		rest: readonly string[],
		opts: ClockOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, `clock ${action}`, opts, async (device) => {
			const real = await this.resolveDeps(deps);
			const record = this.recordOf(ctx, device.lease.id, "clock");
			const [arg, ...extra] = rest;
			if (extra.length > 0 || (action !== "set" && action !== "advance" && arg !== undefined)) {
				return this.fail("usage", `unexpected argument "${extra[0] ?? arg}" for clock ${action}`);
			}
			switch (action) {
				case "set":
					return this.clockSet(ctx, real, device, arg, opts);
				case "advance": {
					const by = durationParser.parse(arg ?? "");
					if (!by.success) return this.fail("usage", `clock advance needs a duration: ${by.error}`, "2d, 3h, 90m");
					return this.applyClock(ctx, real, device, "clock-advance", this.advancedClock(ctx, record, by.data), opts);
				}
				case "status":
					return this.clockStatus(ctx, device, record);
				case "reset":
					return this.clockReset(ctx, real, device, record, opts);
				default:
					return this.fail("usage", `unknown clock action "${action}"`, "set, advance, status or reset");
			}
		});
	}
}

export const uiConditions = new UiConditions();
