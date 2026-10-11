import { availableParallelism } from "node:os";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { defaultMax, profileSlug } from "@delacour/warden-core/allocate";
import { type ClaimOutcome, claimDevices } from "@delacour/warden-core/claim";
import { DEFAULT_PROFILE, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import { detectOwner, type OwnerContext, readGitInfo } from "@delacour/warden-core/owner";
import { listAvds } from "@delacour/warden-core/providers/android";
import type { DeviceRequest, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";
import { autoArrangeSimWindows } from "./sim-windows";

/** Claim options shared by `claim` and `run` (typed by commander's extra-typings). */
export function withClaimOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
		.option("--profile <slug>", "device profile, e.g. iphone-17 / pixel-10 (android default: first AVD)")
		.option("--runtime <runtime>", "runtime: latest, iOS-26-5, 26.5 …")
		.option("--count <n>", "how many devices", "1")
		.option("--max <n>", "max warden devices of this profile (default: cores/4, cap 4)")
		.option("--wait <duration>", "wait this long for a free device, e.g. 10m")
		.option("--ttl <duration>", "lease TTL without heartbeat (default 30m; bare `claim` by an agent: 5m)")
		.option("--label <label>", "label shown in `warden ls`")
		.option("--adopt", "allow allocating foreign (non-warden) devices")
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
	wait?: string;
	ttl?: string;
	label?: string;
	adopt?: boolean;
};

export type ClaimFlags = { request: DeviceRequest; waitMs: number; ttlMs: number; label?: string };

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
 * by an agent passes the short one.
 */
export function parseClaimFlags(
	platformArg: string | undefined,
	values: ClaimFlagValues,
	cores: number = availableParallelism(),
	defaultTtlMs: number = DEFAULT_TTL_MS
): Result<ClaimFlags> {
	const platform = parsePlatform(platformArg);
	if (!platform.success) return platform;
	const count = positiveInt("count", values.count, 1);
	if (!count.success) return count;
	const max = positiveInt("max", values.max, Math.max(defaultMax(cores), count.data), 0);
	if (!max.success) return max;
	const waitMs = values.wait === undefined ? ok(0) : parseDuration(values.wait);
	if (!waitMs.success) return waitMs;
	const ttlMs = values.ttl === undefined ? ok(defaultTtlMs) : parseDuration(values.ttl);
	if (!ttlMs.success) return ttlMs;

	const request: DeviceRequest = {
		platform: platform.data,
		profile: values.profile ?? DEFAULT_PROFILE[platform.data],
		count: count.data,
		max: max.data,
	};
	if (values.runtime !== undefined) request.runtime = values.runtime;
	if (values.adopt) request.adopt = true;
	const flags: ClaimFlags = { request, waitMs: waitMs.data, ttlMs: ttlMs.data };
	if (values.label !== undefined) flags.label = values.label;
	return ok(flags);
}

/** Owner for this invocation: `--session`/hook id → CI → session env → the invoking shell (ppid). */
export function resolveOwner(ctx: CommandContext, sessionId?: string): Owner {
	const ownerCtx: OwnerContext = { env: ctx.env, pid: process.pid, ppid: process.ppid, cwd: ctx.cwd };
	const git = readGitInfo(ctx.cwd);
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

/** Run a device claim with the context's store + provider; iOS claims then tile the sims' windows. */
export async function claimWithFlags(
	ctx: CommandContext,
	owner: Owner,
	flags: ClaimFlags,
	pid: number | undefined
): AsyncResult<ClaimOutcome> {
	let request = flags.request;
	if (request.platform === "android" && request.profile === "auto") {
		const avds = await listAvds({ exec: ctx.exec, env: ctx.env });
		const profile = avds.success ? resolveAutoProfile(avds.data) : avds;
		if (!profile.success) return profile;
		request = { ...request, profile: profile.data };
	}
	const outcome = await claimDevices({
		store: ctx.store(),
		provider: providerFor(request.platform, ctx, owner),
		owner,
		request,
		ttlMs: flags.ttlMs,
		...(flags.label !== undefined ? { label: flags.label } : {}),
		...(pid !== undefined ? { pid } : {}),
		now: ctx.now,
		pidAlive: processAlive,
		waitMs: flags.waitMs,
		log: (line) => ctx.err(`warden: ${line}`),
	});
	if (outcome.success && request.platform === "ios") {
		await autoArrangeSimWindows(
			ctx,
			outcome.data.claimed.map((c) => c.device.name)
		);
	}
	return outcome;
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
