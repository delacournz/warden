import { availableParallelism } from "node:os";
import { defaultMax } from "@warden/core/allocate";
import { type ClaimOutcome, claimDevices } from "@warden/core/claim";
import { DEFAULT_PROFILE, DEFAULT_TTL_MS } from "@warden/core/config.defaults";
import { parseDuration } from "@warden/core/duration";
import { processAlive } from "@warden/core/liveness";
import { detectOwner, type OwnerContext, readGitInfo } from "@warden/core/owner";
import type { DeviceRequest, Owner, Platform } from "@warden/core/types";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

/** `parseArgs` options shared by `claim` and `run`. */
export const CLAIM_OPTIONS = {
	profile: { type: "string" },
	runtime: { type: "string" },
	count: { type: "string" },
	max: { type: "string" },
	wait: { type: "string" },
	ttl: { type: "string" },
	label: { type: "string" },
	adopt: { type: "boolean" },
	json: { type: "boolean" },
} as const;

export const CLAIM_USAGE_FLAGS =
	"[--profile iphone-17] [--runtime latest] [--count N] [--max N] [--wait 10m] [--ttl 30m] [--label x] [--adopt] [--json]";

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

/** Validate claim flags; defaults from `config.defaults` and `defaultMax(cores)`. */
export function parseClaimFlags(
	platformArg: string | undefined,
	values: ClaimFlagValues,
	cores: number = availableParallelism()
): Result<ClaimFlags> {
	const platform = parsePlatform(platformArg);
	if (!platform.success) return platform;
	const count = positiveInt("count", values.count, 1);
	if (!count.success) return count;
	const max = positiveInt("max", values.max, Math.max(defaultMax(cores), count.data), 0);
	if (!max.success) return max;
	const waitMs = values.wait === undefined ? ok(0) : parseDuration(values.wait);
	if (!waitMs.success) return waitMs;
	const ttlMs = values.ttl === undefined ? ok(DEFAULT_TTL_MS) : parseDuration(values.ttl);
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

/** Run a device claim with the context's store + provider. */
export function claimWithFlags(
	ctx: CommandContext,
	owner: Owner,
	flags: ClaimFlags,
	pid: number | undefined
): AsyncResult<ClaimOutcome> {
	return claimDevices({
		store: ctx.store(),
		provider: providerFor(flags.request.platform, ctx, owner),
		owner,
		request: flags.request,
		ttlMs: flags.ttlMs,
		...(flags.label !== undefined ? { label: flags.label } : {}),
		...(pid !== undefined ? { pid } : {}),
		now: ctx.now,
		pidAlive: processAlive,
		waitMs: flags.waitMs,
	});
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
