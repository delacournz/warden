import { availableParallelism } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { DEFAULT_PROFILE, DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { parseDuration } from "@delacour/warden-config/duration";
import type { SlimProfile } from "@delacour/warden-config/slim.profile";
import { resolveSlim, type SlimSetting } from "@delacour/warden-config/slim-policy";
import { defaultMax } from "@delacour/warden-leasing/allocate";
import type { ClaimOutcome, ClaimResult } from "@delacour/warden-leasing/claim";
import {
	bootedByClaim,
	type ClaimHideOptions,
	type ClaimRequest,
	claimWithRequest,
	parsePriorityFlag,
	type SlimLayers,
} from "@delacour/warden-leasing/claim-request";
import { biometricProfile } from "@delacour/warden-providers/biometrics";
import { isGoldenName } from "@delacour/warden-providers/golden-name";
import { slimSimulator } from "@delacour/warden-providers/slim";
import { type DeviceRequest, leaseModel, type Owner, type Platform } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";
import { leaseHostFromContext } from "./lease-host";
import { applyPhysicalAllow, parsePhysicalIds, resolvePhysicalAllow } from "./physical-allow";
import { awaitPhonesUnlocked } from "./physical-lock";

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

/**
 * `--physical` / `--serial` / `--udid`: opt in to real phones and tablets. Kept apart from
 * `withClaimOptions` so only commands that handle a physical device (never boot, shut down or
 * arrange it) offer them.
 */
export function withPhysicalOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
		.option("--physical", "claim a connected physical phone/tablet (never booted, shut down or created by warden)")
		.option("--serial <serial...>", "android: claim these physical devices by adb serial (implies --physical)")
		.option("--udid <udid...>", "ios: claim these physical devices by CoreDevice UDID (implies --physical)");
}

/** Platform from the argument, else (interactive terminal) a picker; undefined = cancelled. */
export async function resolvePlatform(ctx: CommandContext, arg: string | undefined): Promise<Result<Platform>> {
	if (arg !== undefined || !ctx.ui.interactive) return parsePlatform(arg);
	const picked = await ctx.ui.select<Platform>("Which platform?", [
		{ value: "ios", label: "iOS", hint: "simulators" },
		{ value: "android", label: "Android", hint: "emulators" },
	]);
	return picked ? resultFactory.ok(picked) : resultFactory.err("cancelled");
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
	/** `--physical`: only real devices, never create or boot */
	physical?: boolean;
	/** `--serial` (android) / `--udid` (ios): the physical devices to claim; each implies `--physical`. Not named `serial` / `udid`: `dev` and `ui` spread their own options into these values */
	physicalSerial?: string[];
	physicalUdid?: string[];
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

/** Does the claim ask for physical devices (`--physical`, or naming one with `--serial` / `--udid`)? */
export function isPhysicalClaim(
	values: Pick<ClaimFlagValues, "physical" | "physicalSerial" | "physicalUdid">
): boolean {
	return values.physical === true || values.physicalSerial !== undefined || values.physicalUdid !== undefined;
}

/** Commander values of `withPhysicalOptions`: `--serial` / `--udid` are named `physicalSerial` / `physicalUdid` in {@link ClaimFlagValues}. */
export type PhysicalOptionValues = { physical?: boolean; serial?: string[]; udid?: string[] };

/** `opts` with `--serial` / `--udid` (and `--physical`) moved to the claim values' names; `serial` / `udid` are dropped. */
export function withNamedPhysical<T extends PhysicalOptionValues>(
	opts: T
): Omit<T, "serial" | "udid"> & Pick<ClaimFlagValues, "physicalSerial" | "physicalUdid"> {
	const { serial, udid, ...rest } = opts;
	return {
		...rest,
		...(serial ? { physicalSerial: serial } : {}),
		...(udid ? { physicalUdid: udid } : {}),
	};
}

/** The parsed claim flags: a typed {@link ClaimRequest}. */
export type ClaimFlags = ClaimRequest;

/** Claim queue wait when `--wait` is not given. */
export const DEFAULT_WAIT = "30m";

export function parsePlatform(value: string | undefined): Result<Platform> {
	if (value === "ios" || value === "android") return resultFactory.ok(value);
	return resultFactory.err(
		value === undefined ? "missing platform (ios|android)" : `unknown platform "${value}" (ios|android)`
	);
}

function positiveInt(name: string, raw: string | undefined, fallback: number, min = 1): Result<number> {
	if (raw === undefined) return resultFactory.ok(fallback);
	if (!/^\d+$/.test(raw) || Number(raw) < min)
		return resultFactory.err(`--${name} must be an integer >= ${min}, got "${raw}"`);
	return resultFactory.ok(Number(raw));
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
	if (isPhysicalClaim(values)) return parsePhysicalClaim(platform.data, values, defaultTtlMs, defaultPriority);
	const count = positiveInt("count", values.count, 1);
	if (!count.success) return count;
	const max = positiveInt("max", values.max, Math.max(defaultMax(cores), count.data), 0);
	if (!max.success) return max;
	const waitMs = values.wait === false ? resultFactory.ok(0) : parseDuration(values.wait ?? DEFAULT_WAIT);
	if (!waitMs.success) return waitMs;
	const priority = values.priority === undefined ? undefined : parsePriorityFlag(values.priority);
	if (priority && !priority.success) return wardenErrors.toText(priority);
	const ttlMs = values.ttl === undefined ? resultFactory.ok(defaultTtlMs) : parseDuration(values.ttl);
	if (!ttlMs.success) return ttlMs;

	const request = deviceRequest(values, platform.data, count.data, max.data);
	const flags: ClaimFlags = { request, waitMs: waitMs.data, ttlMs: ttlMs.data };
	if (priority) flags.priority = priority.data;
	if (defaultPriority !== undefined) flags.defaultPriority = defaultPriority;
	return resultFactory.ok(withOptionalFlags(flags, values));
}

/** Flags that make no sense on a device warden never creates, boots or arranges. */
function physicalConflict(values: ClaimFlagValues): string | undefined {
	const arranged = "a physical device is never created, booted or arranged";
	const conflicts: Array<[string, boolean, string]> = [
		["--count", values.count !== undefined && values.count !== "1", arranged],
		["--max", values.max !== undefined, arranged],
		["--slim", values.slim === true, arranged],
		["--headless", values.headless === true, arranged],
		["--runtime", values.runtime !== undefined, arranged],
		["--adopt", values.adopt === true, arranged],
		[
			"--biometrics",
			values.biometrics === true,
			"a real Face ID / fingerprint sensor is never enrolled or matched; run biometric specs on a simulator or emulator",
		],
	];
	const found = conflicts.find(([, given]) => given);
	return found ? `${found[0]} cannot be used with --physical (${found[2]})` : undefined;
}

/** `--wait`, `--priority` and `--ttl`, validated: the part of a claim every kind shares. */
function parseTiming(
	values: ClaimFlagValues,
	defaultTtlMs: number
): Result<{ flags: Pick<ClaimFlags, "waitMs" | "ttlMs" | "priority"> }> {
	const waitMs = values.wait === false ? resultFactory.ok(0) : parseDuration(values.wait ?? DEFAULT_WAIT);
	if (!waitMs.success) return waitMs;
	const priority = values.priority === undefined ? undefined : parsePriorityFlag(values.priority);
	if (priority && !priority.success) return wardenErrors.toText(priority);
	const ttlMs = values.ttl === undefined ? resultFactory.ok(defaultTtlMs) : parseDuration(values.ttl);
	if (!ttlMs.success) return ttlMs;
	return resultFactory.ok({
		flags: { waitMs: waitMs.data, ttlMs: ttlMs.data, ...(priority ? { priority: priority.data } : {}) },
	});
}

/** The physical ids named by `--serial` (android) / `--udid` (ios), checked against the platform. */
function physicalIds(platform: Platform, values: ClaimFlagValues): Result<string[] | undefined> {
	if (platform === "ios" && values.physicalSerial !== undefined)
		return resultFactory.err("--serial is android-only; use --udid for iOS");
	if (platform === "android" && values.physicalUdid !== undefined)
		return resultFactory.err("--udid is ios-only; use --serial for Android");
	const ids = platform === "android" ? values.physicalSerial : values.physicalUdid;
	if (ids === undefined) return resultFactory.ok(undefined);
	const bad = platform === "ios" ? ids.find((id) => !leaseModel.isPhysicalIosId(id)) : undefined;
	if (bad !== undefined) {
		return resultFactory.err(
			`--udid ${bad} is not a physical iOS device id (simulators are claimed without --physical)`
		);
	}
	return resultFactory.ok([...new Set(ids)]);
}

/** `parseClaimFlags` for a physical claim: one device per named id (else one), never created or booted. */
function parsePhysicalClaim(
	platform: Platform,
	values: ClaimFlagValues,
	defaultTtlMs: number,
	defaultPriority: number | undefined
): Result<ClaimFlags> {
	const conflict = physicalConflict(values);
	if (conflict) return resultFactory.err(conflict);
	const ids = physicalIds(platform, values);
	if (!ids.success) return ids;
	const timing = parseTiming(values, defaultTtlMs);
	if (!timing.success) return timing;
	const count = ids.data?.length ?? 1;
	const request: DeviceRequest = {
		platform,
		profile: values.profile ?? DEFAULT_PROFILE[platform],
		count,
		max: count,
		physical: ids.data ? { ids: ids.data } : {},
	};
	const flags: ClaimFlags = { request, ...timing.data.flags };
	if (defaultPriority !== undefined) flags.defaultPriority = defaultPriority;
	if (values.label !== undefined) flags.label = values.label;
	return resultFactory.ok(flags);
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

/**
 * An id-less physical claim only picks from the allowlist (`WARDEN_PHYSICAL_IDS`, else `physical.allow` in
 * `warden.config.ts`). A config that cannot be read fails the claim: guessing could take a device the list excludes.
 */
export async function withPhysicalAllowlist(ctx: CommandContext, request: DeviceRequest): AsyncResult<DeviceRequest> {
	if (!request.physical || request.physical.ids !== undefined) return resultFactory.ok(request);
	let configAllow: string[] | undefined;
	if (parsePhysicalIds(ctx.env.WARDEN_PHYSICAL_IDS) === undefined) {
		// loaded here only: a plain claim never pays for the config loader
		const { findWardenConfig } = await import("@delacour/warden-builds/config");
		const found = findWardenConfig(ctx.cwd, undefined, ctx.env);
		if (!found.success)
			return resultFactory.err(`cannot read the physical-device allowlist from warden.config: ${found.error}`);
		configAllow = found.data?.config.physical?.allow;
	}
	return resultFactory.ok(applyPhysicalAllow(request, resolvePhysicalAllow(ctx.env, configAllow)));
}

/**
 * Run a device claim with the context's store + provider (`claimWithRequest` over the command's lease host). Before it:
 * an id-less physical claim is narrowed to the allowlist and a locked iPhone is waited for (nothing is held or queued
 * while the person unlocks it). After it: sims the claim found already booted are slimmed.
 */
export async function claimWithFlags(
	ctx: CommandContext,
	owner: Owner,
	flags: ClaimFlags,
	pid: number | undefined,
	options: ClaimHideOptions = {}
): Promise<ClaimResult> {
	const allowed = await withPhysicalAllowlist(ctx, flags.request);
	if (!allowed.success) return wardenErrors.coded(allowed, "failed");
	const request = allowed.data;
	if (request.physical !== undefined && request.platform === "ios") {
		const unlocked = await awaitPhonesUnlocked(ctx, owner, request, {
			noWait: flags.waitMs === 0,
			...(options.abort ? { abort: options.abort } : {}),
			...(options.unlockSleep ? { sleep: options.unlockSleep } : {}),
		});
		if (!unlocked.success) return wardenErrors.coded(unlocked, "failed");
	}
	const outcome = await claimWithRequest(leaseHostFromContext(ctx), owner, { ...flags, request }, pid, options);
	if (outcome.success && request.platform === "ios" && !request.physical) {
		const slim = resolveSlim({ ...flags.slim, env: ctx.env });
		if (slim.success) await slimReusedBooted(ctx, outcome.data, slim.data);
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
