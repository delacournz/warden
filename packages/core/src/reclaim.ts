import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "./exec";
import { isGoldenName } from "./golden/golden";
import { type MarkerFs, markerBlock, realMarkerFs } from "./ownership";
import { androidTools, isEmulatorSerial } from "./providers/android";
import type { DeviceRecord, Store } from "./store";
import { isPhysicalIosId, type Platform } from "./types";

/**
 * Reclaim on release (opt-in): what happens to a warden device's state when its lease ends.
 * `erase` = shutdown + `simctl erase` (Android: falls back to `uninstall`, see `reclaimDevice`),
 * `uninstall` = remove the user-installed apps, `none` = leave it as it is (the default).
 */
export type ReclaimMode = "erase" | "uninstall" | "none";

export const RECLAIM_MODES: readonly ReclaimMode[] = ["erase", "uninstall", "none"];

export const parseReclaimMode = (value: string | undefined): ReclaimMode | undefined => {
	const v = value?.trim().toLowerCase();
	return RECLAIM_MODES.find((m) => m === v);
};

/** Where a run's `reclaim` can come from, highest precedence first. */
export type ReclaimInput = {
	/** `e2e.<suite>.reclaim` / `batches.<name>.reclaim`, else the top-level `reclaim` */
	config?: ReclaimMode | undefined;
	env: Record<string, string | undefined>;
};

/** Precedence: config (suite / preset > top-level) > `WARDEN_RECLAIM` (an unknown value is ignored) > `none`. */
export function resolveReclaim(input: ReclaimInput): ReclaimMode {
	return input.config ?? parseReclaimMode(input.env.WARDEN_RECLAIM) ?? "none";
}

/** label + TTL of the lease held on a device while it is reclaimed (a dead process's lease goes stale after this) */
export const RECLAIM_LABEL = "reclaiming";
export const RECLAIM_TTL_MS = 3 * 60_000;

/** Quarantines a failed reclaim sets carry this reason prefix; unlike `claim: ` ones they never expire on a timer. */
export const RECLAIM_QUARANTINE_PREFIX = "reclaim: ";
/** tries in all (the first and its retries) before the device stays quarantined */
export const RECLAIM_MAX_TRIES = 3;
export const RECLAIM_BACKOFF_BASE_MS = 30_000;
export const RECLAIM_BACKOFF_CAP_MS = 5 * 60_000;

/** Wait before the retry that follows the `failures`-th failure: 30 s, 60 s, … capped at 5 min. */
export function reclaimBackoffMs(failures: number): number {
	return Math.min(RECLAIM_BACKOFF_CAP_MS, RECLAIM_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** Retry bookkeeping of a reclaim quarantine (store meta); `nextAt` is absent once the tries are used up. */
export type ReclaimState = { mode: Exclude<ReclaimMode, "none">; tries: number; nextAt?: number };

const stateKey = (platform: Platform, id: string): string => `reclaim:${platform}:${id}`;

export function readReclaimState(store: Store, platform: Platform, id: string): ReclaimState | undefined {
	const raw = store.getMeta(stateKey(platform, id));
	if (raw === undefined) return undefined;
	try {
		const v: unknown = JSON.parse(raw);
		if (typeof v !== "object" || v === null) return undefined;
		const mode = "mode" in v ? parseReclaimMode(String(v.mode)) : undefined;
		const tries = "tries" in v && typeof v.tries === "number" ? v.tries : undefined;
		if (mode === undefined || mode === "none" || tries === undefined) return undefined;
		return {
			mode,
			tries,
			...("nextAt" in v && typeof v.nextAt === "number" ? { nextAt: v.nextAt } : {}),
		};
	} catch {
		return undefined;
	}
}

export const clearReclaimState = (store: Store, platform: Platform, id: string): void =>
	store.deleteMeta(stateKey(platform, id));

const isReclaimQuarantine = (record: DeviceRecord): boolean =>
	record.quarantinedAt !== undefined && record.quarantineReason?.startsWith(RECLAIM_QUARANTINE_PREFIX) === true;

/**
 * Why a device must not be reclaimed, or undefined when it may be. Only warden's own simulators and emulators
 * qualify: a device with no store record is foreign, goldens are clone sources, phones are never touched, and a
 * device somebody quarantined (`release --bad`) is kept as it is for inspection.
 */
export function reclaimSkipReason(store: Store, platform: Platform, id: string, physical: boolean): string | undefined {
	if (physical || (platform === "ios" ? isPhysicalIosId(id) : !isEmulatorSerial(id))) {
		return "physical device: reclaim skipped";
	}
	const record = store.listDevices(platform).find((d) => d.id === id);
	if (record === undefined) return `${id} is not a warden device: reclaim skipped`;
	if (isGoldenName(record.name)) return `${record.name} is a golden image: reclaim skipped`;
	if (record.quarantinedAt !== undefined && !isReclaimQuarantine(record)) {
		return `${record.name} is quarantined: reclaim skipped`;
	}
	return undefined;
}

export type ReclaimDeps = {
	exec: Exec;
	store: Store;
	env: Record<string, string | undefined>;
	now: () => number;
	/** where the ownership marker is read (default: the real filesystem) */
	markerFs?: MarkerFs;
};

export type ReclaimOutcome =
	| { kind: "done"; note?: string }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; error: string };

export type InstalledApp = { id: string; type: string };

/** Parses `xcrun simctl listapps` (old-style plist): each entry's `ApplicationType` pairs with the `CFBundleIdentifier` after it. */
export function parseListApps(text: string): InstalledApp[] {
	const apps: InstalledApp[] = [];
	let type = "";
	for (const line of text.split("\n")) {
		const t = /^\s*ApplicationType\s*=\s*"?([^";\s]+)"?\s*;/.exec(line);
		if (t?.[1] !== undefined) type = t[1];
		const id = /^\s*CFBundleIdentifier\s*=\s*"?([^";\s]+)"?\s*;/.exec(line);
		if (id?.[1] !== undefined) apps.push({ id: id[1], type });
	}
	return apps;
}

/** warden's own runner apps are not the run's residue */
const KEEP_APP_PREFIXES: readonly string[] = ["com.apple.", "nz.co.delacour.warden."];

/** User-installed apps on a sim: `ApplicationType = User`, minus system and warden's own. */
export const userAppIds = (listapps: string): string[] =>
	parseListApps(listapps)
		.filter((a) => a.type === "User" && !KEEP_APP_PREFIXES.some((p) => a.id.startsWith(p)))
		.map((a) => a.id);

/** `adb shell pm list packages -3` → package ids */
export function parseThirdPartyPackages(text: string): string[] {
	return text.split("\n").flatMap((line) => {
		const m = /^package:(\S+)/.exec(line.trim());
		return m?.[1] === undefined ? [] : [m[1]];
	});
}

const SIMCTL_MS = 60_000;

async function run(exec: Exec, cmd: readonly string[]): AsyncResult<string> {
	const r = await exec(cmd, { timeoutMs: SIMCTL_MS });
	if (r.exitCode === 0) return ok(r.stdout);
	return err(`${cmd.join(" ")} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
}

async function eraseIos(exec: Exec, udid: string): AsyncResult<void> {
	const down = await exec(["xcrun", "simctl", "shutdown", udid], { timeoutMs: SIMCTL_MS });
	if (down.exitCode !== 0 && !`${down.stderr}\n${down.stdout}`.includes("current state: Shutdown")) {
		return err(`simctl shutdown ${udid} exited ${down.exitCode}: ${(down.stderr || down.stdout).trim().slice(0, 300)}`);
	}
	const erased = await run(exec, ["xcrun", "simctl", "erase", udid]);
	return erased.success ? ok(undefined) : erased;
}

async function uninstallIos(exec: Exec, udid: string): AsyncResult<string | undefined> {
	const listed = await exec(["xcrun", "simctl", "listapps", udid], { timeoutMs: SIMCTL_MS });
	if (listed.exitCode !== 0) {
		if (`${listed.stderr}\n${listed.stdout}`.includes("current state: Shutdown")) {
			return ok("shut down: its apps were left (uninstall needs a booted simulator)");
		}
		return err(
			`simctl listapps ${udid} exited ${listed.exitCode}: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`
		);
	}
	for (const id of userAppIds(listed.stdout)) {
		const removed = await run(exec, ["xcrun", "simctl", "uninstall", udid, id]);
		if (!removed.success) return removed;
	}
	return ok(undefined);
}

async function uninstallAndroid(deps: ReclaimDeps, serial: string): AsyncResult<void> {
	const { adb } = androidTools(deps.env);
	const listed = await run(deps.exec, [adb, "-s", serial, "shell", "pm", "list", "packages", "-3"]);
	if (!listed.success) return listed;
	for (const pkg of parseThirdPartyPackages(listed.data)) {
		const removed = await run(deps.exec, [adb, "-s", serial, "uninstall", pkg]);
		if (!removed.success) return removed;
	}
	return ok(undefined);
}

/**
 * Reclaim one device the caller already holds a `reclaiming` lease on. iOS `erase` = shutdown + `simctl erase`;
 * `uninstall` = remove the `User` apps (a golden image bakes no apps, so everything user-installed is the run's).
 * Android emulators run `-read-only` and have no erase that is safe against a running instance, so `erase` there
 * is `uninstall` of the third-party packages.
 */
export async function reclaimDevice(
	deps: ReclaimDeps,
	platform: Platform,
	id: string,
	mode: ReclaimMode,
	physical = false
): Promise<ReclaimOutcome> {
	if (mode === "none") return { kind: "skipped", reason: "reclaim is none" };
	const skip = reclaimSkipReason(deps.store, platform, id, physical);
	if (skip !== undefined) return { kind: "skipped", reason: skip };
	const owned = platform === "ios" ? markerBlock(deps.markerFs ?? realMarkerFs, deps.env, deps.store, id) : undefined;
	if (owned !== undefined) return { kind: "skipped", reason: owned };
	if (platform === "android") {
		const done = await uninstallAndroid(deps, id);
		if (!done.success) return { kind: "failed", error: done.error };
		return mode === "erase"
			? { kind: "done", note: `${id}: android erase = uninstalled third-party apps` }
			: { kind: "done" };
	}
	if (mode === "erase") {
		const done = await eraseIos(deps.exec, id);
		return done.success ? { kind: "done" } : { kind: "failed", error: done.error };
	}
	const done = await uninstallIos(deps.exec, id);
	if (!done.success) return { kind: "failed", error: done.error };
	return done.data === undefined ? { kind: "done" } : { kind: "done", note: `${id}: ${done.data}` };
}

/** A reclaim succeeded: the device is offered again (a reclaim quarantine is lifted) and its retry state dropped. */
export function reclaimSucceeded(store: Store, platform: Platform, id: string, now: number): void {
	const record = store.listDevices(platform).find((d) => d.id === id);
	if (record !== undefined && isReclaimQuarantine(record)) store.unquarantineDevice(id, now);
	clearReclaimState(store, platform, id);
}

/**
 * A reclaim failed: quarantine the device with a `reclaim: ` reason and schedule the retry that `warden gc` runs
 * (`dueReclaims`). The try count carries over only from an earlier reclaim quarantine of the same device; after
 * `RECLAIM_MAX_TRIES` the device stays quarantined with no retry until `warden sim unquarantine`.
 */
export function reclaimFailed(
	store: Store,
	record: DeviceRecord,
	mode: Exclude<ReclaimMode, "none">,
	error: string,
	now: number
): ReclaimState {
	const current = store.listDevices(record.platform).find((d) => d.id === record.id) ?? record;
	const prior = isReclaimQuarantine(current) ? readReclaimState(store, record.platform, record.id) : undefined;
	const tries = (prior?.tries ?? 0) + 1;
	const spent = tries >= RECLAIM_MAX_TRIES;
	const state: ReclaimState = { mode, tries, ...(spent ? {} : { nextAt: now + reclaimBackoffMs(tries) }) };
	const reason = spent
		? `${RECLAIM_QUARANTINE_PREFIX}${mode} failed ${tries} times, giving up: ${error}`
		: `${RECLAIM_QUARANTINE_PREFIX}${mode} failed (try ${tries}/${RECLAIM_MAX_TRIES}), retrying in ${reclaimBackoffMs(tries) / 1000}s: ${error}`;
	store.quarantineDevice(
		{
			platform: record.platform,
			id: record.id,
			name: record.name,
			...(record.profile !== undefined ? { profile: record.profile } : {}),
			...(record.runtime !== undefined ? { runtime: record.runtime } : {}),
		},
		reason,
		now
	);
	store.setMeta(stateKey(record.platform, record.id), JSON.stringify(state));
	return state;
}

export type DueReclaim = { record: DeviceRecord; mode: Exclude<ReclaimMode, "none"> };

/** Reclaim-quarantined devices whose backoff has elapsed and that have tries left. */
export function dueReclaims(store: Store, now: number): DueReclaim[] {
	return (["ios", "android"] as const).flatMap((platform) =>
		store.listDevices(platform).flatMap((record) => {
			if (!isReclaimQuarantine(record)) return [];
			const state = readReclaimState(store, platform, record.id);
			if (state?.nextAt === undefined || state.nextAt > now || state.tries >= RECLAIM_MAX_TRIES) return [];
			return [{ record, mode: state.mode }];
		})
	);
}
