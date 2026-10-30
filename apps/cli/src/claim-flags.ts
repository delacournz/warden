import { availableParallelism } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { defaultMax, profileSlug } from "@delacour/warden-core/allocate";
import { biometricProfile, splitBiometricProfile } from "@delacour/warden-core/biometrics";
import { maxConcurrent } from "@delacour/warden-core/capacity";
import { type ClaimedDevice, type ClaimOutcome, claimDevices } from "@delacour/warden-core/claim";
import { DEFAULT_PROFILE, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { isGoldenName } from "@delacour/warden-core/golden/golden";
import { processAlive } from "@delacour/warden-core/liveness";
import { detectOwner, type OwnerContext, readGitInfo } from "@delacour/warden-core/owner";
import { listAvds } from "@delacour/warden-core/providers/android";
import { PRIORITY, parsePriority } from "@delacour/warden-core/queue";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
import type { SlimProfile } from "@delacour/warden-core/sims/slim.profile";
import { resolveSlim, type SlimSetting } from "@delacour/warden-core/slim-policy";
import type { DeviceRequest, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import { buildCapacityDeps } from "./capacity-deps";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";
import {
	autoArrangeSimWindows,
	type DetachLock,
	type HideDeps,
	type HideStart,
	hideSimWindows,
	openDeviceHubWindows,
	startHideSimWindows,
} from "./sim-windows";

/** Claim options shared by `claim` and `run` (typed by commander's extra-typings). */
export function withClaimOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
		.option("--profile <slug>", "device profile, e.g. iphone-17 / pixel-10 (android default: first AVD)")
		.option("--runtime <runtime>", "runtime: latest, iOS-26-5, 26.5 …")
		.option("--count <n>", "how many devices", "1")
		.option("--max <n>", "max warden devices of this profile (default: what the machine's capacity allows)")
		.option("--wait <duration>", `queue up to this long for a free device or host capacity (default ${DEFAULT_WAIT})`)
		.option("--no-wait", "fail at once instead of queueing when no device is free")
		.option(
			"--priority <priority>",
			"boot-queue priority: interactive|high|normal|low or a number (env WARDEN_PRIORITY; default by command)"
		)
		.option("--ttl <duration>", "lease TTL without heartbeat (default 30m; bare `claim` by an agent: 5m)")
		.option("--label <label>", "label shown in `warden ls`")
		.option("--adopt", "allow allocating foreign (non-warden) devices")
		.option("--headless", "iOS: close the claimed sims' Simulator.app windows (no window, even with Simulator open)")
		.option("--no-headless", "show the windows even when config / WARDEN_HEADLESS say headless")
		.option("--slim", "iOS: slim the simulator daemons (default; ignored on android)")
		.option(
			"--no-slim",
			"iOS: leave the simulator daemons running (config slim / WARDEN_SLIM=0 also turn slimming off)"
		)
		.option(
			"--biometrics",
			"claim devices with a fingerprint / Face ID enrolled (own pool and golden; config biometrics)"
		)
		.option("--json", "machine-readable output");
}

/** Platform from the argument, else (interactive terminal) a picker; undefined = cancelled. */
export async function resolvePlatform(ctx: CommandContext, arg: string | undefined): Promise<Result<Platform>> {
	if (arg !== undefined || !ctx.ui.interactive) return parsePlatform(arg);
	const picked = await ctx.ui.select<Platform>("Which platform?", [
		{ value: "ios", label: "iOS", hint: "simulators" },
		{ value: "android", label: "Android", hint: "emulators" },
	]);
	return picked ? ok(picked) : err("cancelled");
}

export type ClaimFlagValues = {
	profile?: string;
	runtime?: string;
	count?: string;
	max?: string;
	/** a duration, or `false` for `--no-wait` */
	wait?: string | false;
	priority?: string;
	ttl?: string;
	label?: string;
	adopt?: boolean;
	/** the run's resolved headless (callers apply `resolveHeadless` first) */
	headless?: boolean;
	/** `--slim` / `--no-slim` (undefined = not passed) */
	slim?: boolean | undefined;
	/** `e2e.<suite>.slim` / preset `slim`, already picked by the caller */
	slimConfig?: SlimSetting | undefined;
	/** top-level config `slim` */
	slimTopLevel?: SlimSetting | undefined;
	/** `--biometrics`, or the suite / preset / top-level config `biometrics` already picked by the caller */
	biometrics?: boolean | undefined;
};

/** The layers `resolveSlim` merges for a claim. */
export type SlimLayers = { flag?: boolean; config?: SlimSetting; topLevel?: SlimSetting };

export type ClaimFlags = {
	request: DeviceRequest;
	/** how long the claim may wait for a free device / host capacity; 0 = fail at once */
	waitMs: number;
	/** `--priority`, when given (beats `WARDEN_PRIORITY` and the command's default) */
	priority?: number;
	/** the calling command's priority when neither `--priority` nor `WARDEN_PRIORITY` says */
	defaultPriority?: number;
	/** `--max` was not given: with capacity on, the pool grows to what the machine allows */
	maxDefaulted?: true;
	ttlMs: number;
	label?: string;
	/** iOS: close the claimed sims' Simulator.app windows instead of tiling them */
	headless?: true;
	/** iOS daemon slimming layers (flag > suite / preset > top-level config > `WARDEN_SLIM` > on); android ignores them */
	slim?: SlimLayers;
};

/** Claim queue wait when `--wait` is not given. */
export const DEFAULT_WAIT = "30m";

/** `interactive|high|normal|low` or a non-negative integer. */
export function parsePriorityFlag(raw: string): Result<number> {
	const parsed = parsePriority(raw);
	return parsed.success ? parsed : err(`--priority: ${parsed.error}`);
}

/** Priority of a claim: `--priority`, else `WARDEN_PRIORITY`, else the command's default, else normal. */
export function resolvePriority(flags: ClaimFlags, env: Record<string, string | undefined>): Result<number> {
	if (flags.priority !== undefined) return ok(flags.priority);
	const fromEnv = env.WARDEN_PRIORITY?.trim();
	if (fromEnv) {
		const parsed = parsePriorityFlag(fromEnv);
		return parsed.success ? parsed : err(`WARDEN_PRIORITY=${fromEnv}: ${parsed.error}`);
	}
	return ok(flags.defaultPriority ?? PRIORITY.normal);
}

export function parsePlatform(value: string | undefined): Result<Platform> {
	if (value === "ios" || value === "android") return ok(value);
	return err(value === undefined ? "missing platform (ios|android)" : `unknown platform "${value}" (ios|android)`);
}

function positiveInt(name: string, raw: string | undefined, fallback: number, min = 1): Result<number> {
	if (raw === undefined) return ok(fallback);
	if (!/^\d+$/.test(raw) || Number(raw) < min) return err(`--${name} must be an integer >= ${min}, got "${raw}"`);
	return ok(Number(raw));
}

/**
 * Validate claim flags; defaults from `config.defaults` and `defaultMax(cores)`. `defaultTtlMs` is
 * what `--ttl` falls back to: wrappers keep the 30 min default (they heartbeat); only bare `claim`
 * by an agent passes the short one. `defaultPriority` is the calling command's queue priority.
 */
export function parseClaimFlags(
	platformArg: string | undefined,
	values: ClaimFlagValues,
	cores: number = availableParallelism(),
	defaultTtlMs: number = DEFAULT_TTL_MS,
	defaultPriority?: number
): Result<ClaimFlags> {
	const platform = parsePlatform(platformArg);
	if (!platform.success) return platform;
	const count = positiveInt("count", values.count, 1);
	if (!count.success) return count;
	const max = positiveInt("max", values.max, Math.max(defaultMax(cores), count.data), 0);
	if (!max.success) return max;
	const waitMs = values.wait === false ? ok(0) : parseDuration(values.wait ?? DEFAULT_WAIT);
	if (!waitMs.success) return waitMs;
	const priority = values.priority === undefined ? undefined : parsePriorityFlag(values.priority);
	if (priority && !priority.success) return priority;
	const ttlMs = values.ttl === undefined ? ok(defaultTtlMs) : parseDuration(values.ttl);
	if (!ttlMs.success) return ttlMs;

	const request = deviceRequest(values, platform.data, count.data, max.data);
	const flags: ClaimFlags = { request, waitMs: waitMs.data, ttlMs: ttlMs.data };
	if (priority) flags.priority = priority.data;
	if (defaultPriority !== undefined) flags.defaultPriority = defaultPriority;
	return ok(withOptionalFlags(flags, values));
}

function deviceRequest(values: ClaimFlagValues, platform: Platform, count: number, max: number): DeviceRequest {
	const profile = biometricProfile(values.profile ?? DEFAULT_PROFILE[platform], values.biometrics === true);
	const request: DeviceRequest = { platform, profile, count, max };
	if (values.runtime !== undefined) request.runtime = values.runtime;
	if (values.adopt) request.adopt = true;
	return request;
}

/** The flags that only exist when given: `--label`, `--headless`, and `maxDefaulted` when `--max` was not. */
function withOptionalFlags(flags: ClaimFlags, values: ClaimFlagValues): ClaimFlags {
	if (values.max === undefined) flags.maxDefaulted = true;
	if (values.label !== undefined) flags.label = values.label;
	if (values.headless) flags.headless = true;
	const slim: SlimLayers = {};
	if (values.slim !== undefined) slim.flag = values.slim;
	if (values.slimConfig !== undefined) slim.config = values.slimConfig;
	if (values.slimTopLevel !== undefined) slim.topLevel = values.slimTopLevel;
	if (Object.keys(slim).length > 0) flags.slim = slim;
	return flags;
}

/** Owner for this invocation: `--session`/hook id → CI → session env → the invoking shell (ppid). */
export function resolveOwner(ctx: CommandContext, sessionId?: string): Owner {
	const ownerCtx: OwnerContext = { env: ctx.env, pid: process.pid, ppid: process.ppid, cwd: ctx.cwd };
	const git = readGitInfo(ctx.cwd, { cache: ctx.git });
	if (git) ownerCtx.git = git;
	if (sessionId) ownerCtx.sessionId = sessionId;
	return detectOwner(ownerCtx);
}

/** Lookup-only owner for `--session S` (owner_key only uses the session id). */
export function sessionOwner(sessionId: string, cwd = ""): Owner {
	return { kind: "agent", sessionId, cwd };
}

/** User leases live as long as their shell; agent / CI leases rely on heartbeat + ttl. */
export function leasePidFor(owner: Owner): number | undefined {
	return owner.kind === "user" ? owner.pid : undefined;
}

/** Android `auto` profile → slug of the first AVD. */
export function resolveAutoProfile(avds: readonly string[]): Result<string> {
	const first = avds[0];
	return first
		? ok(profileSlug(first))
		: err("no Android AVDs found (`emulator -list-avds`) — create one or pass --profile");
}

/** Simulator's close setting, shared with every other warden process through the context's store. */
export function detachLockFor(ctx: CommandContext): DetachLock {
	return { store: ctx.store(), pid: process.pid, pidAlive: processAlive };
}

/** `hideSimWindows` deps from a command context: problems are yellow `warden: …` lines; a device the close shut down loses its resident helper. */
export function headlessDeps(ctx: CommandContext): HideDeps {
	return {
		exec: ctx.exec,
		warn: (line) => ctx.err(ctx.ui.color.yellow(`warden: ${line}`)),
		onShutDown: stopHelperAfter(ctx),
		detachLock: detachLockFor(ctx),
	};
}

export type ClaimHideOptions = {
	/**
	 * Headless iOS: return once the windows are closed and hand the rest of the hide here, instead of
	 * awaiting it. The caller must not use a device in `start.down` before `start.settled` (it is being
	 * booted again), and awaits `settled` before it ends (that puts Simulator's close setting back).
	 */
	onHide?: (start: HideStart) => void;
	/** the platform the hide runs on (tests); defaults to `process.platform` */
	os?: NodeJS.Platform;
	/** polled while the claim waits (queue, pool): true ends it with `CLAIM_ABORTED` */
	abort?: () => boolean;
};

/**
 * The claimed devices this claim had to boot or create: the only ones whose Simulator.app window can
 * still be on its way. A device that was already running (`reuse`, not booted by the claim) keeps
 * the window — or the lack of one, when it booted headless — it had.
 */
export function bootedByClaim(outcome: Pick<ClaimOutcome, "claimed">): ClaimedDevice[] {
	return outcome.claimed.filter((c) => c.action !== "reuse" || c.lease.bootedByOwner === true);
}

/** Android `auto` profile → the first AVD; every other request as is. */
async function resolveRequest(ctx: CommandContext, request: DeviceRequest): AsyncResult<DeviceRequest> {
	const { profile: base, biometrics } = splitBiometricProfile(request.profile);
	if (request.platform !== "android" || base !== "auto") return ok(request);
	const avds = await listAvds({ exec: ctx.exec, env: ctx.env });
	const profile = avds.success ? resolveAutoProfile(avds.data) : avds;
	return profile.success ? ok({ ...request, profile: biometricProfile(profile.data, biometrics) }) : profile;
}

/** Run a device claim with the context's store + provider; iOS claims then tile the sims' windows (headless: close them; see `options.onHide`). */
export async function claimWithFlags(
	ctx: CommandContext,
	owner: Owner,
	flags: ClaimFlags,
	pid: number | undefined,
	options: ClaimHideOptions = {}
): AsyncResult<ClaimOutcome> {
	const resolved = await resolveRequest(ctx, flags.request);
	if (!resolved.success) return resolved;
	let request = resolved.data;
	const priority = resolvePriority(flags, ctx.env);
	if (!priority.success) return priority;
	const capacity = await buildCapacityDeps(ctx, owner);
	if (capacity && flags.maxDefaulted) {
		const room = maxConcurrent(request.platform, capacity.budget, capacity.config);
		request = { ...request, max: Math.max(request.max, room) };
	}
	const slim = resolveSlim({ ...flags.slim, env: ctx.env });
	if (!slim.success) return slim;
	const outcome = await claimDevices({
		store: ctx.store(),
		provider: providerFor(request.platform, ctx, owner, request.platform === "ios" ? { slim: slim.data } : {}),
		...(request.platform === "ios" ? { slim: slim.data !== false } : {}),
		owner,
		request,
		ttlMs: flags.ttlMs,
		...(flags.label !== undefined ? { label: flags.label } : {}),
		...(pid !== undefined ? { pid } : {}),
		now: ctx.now,
		pidAlive: processAlive,
		waitMs: flags.waitMs,
		priority: priority.data,
		...(options.abort ? { abort: options.abort } : {}),
		...(capacity ? { capacity } : {}),
		orphans: { exec: ctx.exec, env: ctx.env },
		log: (line) => ctx.err(`warden: ${line}`),
	});
	if (outcome.success && request.platform === "ios") {
		await slimReusedBooted(ctx, outcome.data, slim.data);
		await settleIosWindows(ctx, outcome.data, flags, options);
	}
	return outcome;
}

/**
 * Sims this claim found already booted (so the provider never saw them boot) and that warden knows
 * but never slimmed: slim them live now. Best effort; devices warden has no record of (foreign) are left alone.
 */
async function slimReusedBooted(ctx: CommandContext, outcome: ClaimOutcome, slim: SlimProfile | false): Promise<void> {
	if (slim === false) return;
	const booted = new Set(bootedByClaim(outcome).map((c) => c.device.id));
	const records = new Map(
		ctx
			.store()
			.listDevices("ios")
			.map((r) => [r.id, r])
	);
	for (const { device } of outcome.claimed) {
		const record = records.get(device.id);
		if (booted.has(device.id) || !record || record.slimmedAt !== undefined || isGoldenName(record.name)) continue;
		const res = await slimSimulator(ctx.exec, device.id, { profile: slim });
		if (res.success) ctx.store().setSlimmed("ios", device.id, ctx.now());
		else ctx.err(ctx.ui.color.yellow(`warden: ${device.name} could not be slimmed: ${res.error}`));
	}
}

/** Call for a `--no-slim` claim (outside any spinner): a claimed sim that is slimmed gets the restore hint. */
export function hintSlimmed(ctx: CommandContext, outcome: ClaimOutcome): void {
	const records = new Map(
		ctx
			.store()
			.listDevices("ios")
			.map((r) => [r.id, r])
	);
	for (const { device } of outcome.claimed) {
		if (records.get(device.id)?.slimmedAt === undefined) continue;
		ctx.err(`warden claim: ${device.name} is slimmed; warden sim slim ${device.id} --restore re-enables its daemons`);
	}
}

/** After an iOS claim: headless closes the sims' windows (handing the rest to `onHide` when given); otherwise tile them. */
async function settleIosWindows(
	ctx: CommandContext,
	outcome: ClaimOutcome,
	flags: ClaimFlags,
	options: ClaimHideOptions
): Promise<void> {
	const sims = outcome.claimed.map((c) => ({ udid: c.device.id, name: c.device.name }));
	const deps = options.os === undefined ? headlessDeps(ctx) : { ...headlessDeps(ctx), os: options.os };
	if (flags.headless && options.onHide) options.onHide(await startHideSimWindows(deps, sims));
	else if (flags.headless) await hideSimWindows(deps, sims);
	else {
		const booted = bootedByClaim(outcome).map((c) => ({ udid: c.device.id, name: c.device.name }));
		const windowDeps = options.os === undefined ? ctx : { exec: ctx.exec, env: ctx.env, os: options.os };
		const opened = await openDeviceHubWindows(windowDeps, booted);
		await autoArrangeSimWindows(
			windowDeps,
			booted.map((s) => s.name),
			opened,
			(missing) =>
				openDeviceHubWindows(
					windowDeps,
					booted.filter((s) => missing.includes(s.name))
				)
		);
	}
}

/** JSON shape of claimed devices, shared by `claim` and `run`. */
export function claimedJson(outcome: ClaimOutcome) {
	return outcome.claimed.map((c) => ({
		leaseId: c.lease.id,
		platform: c.device.platform,
		udid: c.device.id,
		name: c.device.name,
		action: c.action,
		ttlMs: c.lease.ttlMs,
		...(c.lease.label !== undefined ? { label: c.lease.label } : {}),
	}));
}
