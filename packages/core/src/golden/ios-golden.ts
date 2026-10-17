/**
 * Side-effect half of golden simulators (see `golden.ts`): build, reuse, clone, prune. All work on
 * goldens runs under one machine-wide warden lease (`golden:ios`), so a build, clone or prune in one
 * process never races another — a clone never sees a half-built or deleted golden.
 */
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { withBuildLock } from "../builds/lock";
import { type Exec, execError } from "../exec";
import type { PidAlive } from "../liveness";
import { execWithin, realTimer, type Timer } from "../providers/health";
import { IOS_TIMEOUTS, lookupCreateTarget, timedOutError } from "../providers/ios";
import { parseAllSims, type SimctlSim } from "../sims/list";
import type { Store } from "../store";
import type { Owner } from "../types";
import {
	GOLDEN_PREFIX,
	type GoldenInputs,
	goldenKey,
	goldenName,
	isSettled,
	migrationDone,
	olderRecipeNames,
	parseXcodeBuild,
	planGolden,
	wipName,
} from "./golden";

export const GOLDEN_LOCK_KEY = "golden:ios";

export type GoldenTiming = {
	bootTimeoutMs: number;
	migrationPollMs: number;
	migrationMaxMs: number;
	settleIntervalMs: number;
	settleMaxMs: number;
	maxCpu: number;
	window: number;
	lockWaitMs: number;
};

/** Settle: <40 % CPU over 3 × 10 s, capped at 5 min (salient SAL-GOLDEN measurements). */
export const DEFAULT_GOLDEN_TIMING: GoldenTiming = {
	bootTimeoutMs: 15 * 60_000,
	migrationPollMs: 5_000,
	migrationMaxMs: 15 * 60_000,
	settleIntervalMs: 10_000,
	settleMaxMs: 5 * 60_000,
	maxCpu: 40,
	window: 3,
	lockWaitMs: 40 * 60_000,
};

/** Waiters on the golden lock retry this often: clones hold it for seconds, not the builds' minutes (16-6). */
export const GOLDEN_LOCK_POLL_MS = 200;
/** `xcode-select` / `plutil` / `xcodebuild -version` reads of the Xcode build (16-11). */
const XCODE_READ_TIMEOUT_MS = 30_000;
/** The in-sim `defaults write` of the golden recipe. */
const DEFAULTS_WRITE_TIMEOUT_MS = 30_000;

export type GoldenDeps = {
	exec: Exec;
	store: Store;
	owner: Owner;
	/** pid recorded on the golden lock */
	pid: number;
	env: Record<string, string | undefined>;
	now: () => number;
	pidAlive: PidAlive;
	sleep: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	/** a claim is waiting on this build: say how to prewarm it (off for `warden golden ensure`, which is the prewarm) */
	prewarmHint?: boolean;
	timing?: Partial<GoldenTiming>;
	/** bounds every simctl / Xcode call (default: real timers) */
	timer?: (ms: number) => Timer;
};

export type GoldenTarget = GoldenInputs & { profile: string };
export type EnsuredGolden = { udid: string; name: string; built: boolean };
export type ClonedDevice = { udid: string; name: string; golden: string; runtimeId: string };

/** Run `cmd`; with `timeoutMs`, a call still running then is an error (and the process is killed). */
async function run(deps: GoldenDeps, cmd: string[], timeoutMs?: number): AsyncResult<string> {
	const result =
		timeoutMs === undefined
			? await deps.exec(cmd)
			: await execWithin({ exec: deps.exec, timer: deps.timer ?? realTimer }, cmd, timeoutMs);
	if (result === undefined) return err(timedOutError(cmd, timeoutMs ?? 0));
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

const simctl = (deps: GoldenDeps, args: string[], timeoutMs?: number) =>
	run(deps, ["xcrun", "simctl", ...args], timeoutMs);

function timing(deps: GoldenDeps): GoldenTiming {
	return { ...DEFAULT_GOLDEN_TIMING, ...deps.timing };
}

const log = (deps: GoldenDeps, line: string) => deps.log?.(`golden: ${line}`);

/**
 * The selected Xcode's build: `ProductBuildVersion` of `$(xcode-select -p)/../version.plist` (two
 * ~10 ms spawns), else `xcodebuild -version` (0.4–1 s). Both name the same build (`17F113`).
 */
async function readXcodeBuild(deps: GoldenDeps): AsyncResult<string> {
	const developer = await run(deps, ["xcode-select", "-p"], XCODE_READ_TIMEOUT_MS);
	if (developer.success && developer.data.trim()) {
		const plist = join(dirname(developer.data.trim()), "version.plist");
		const build = await run(
			deps,
			["plutil", "-extract", "ProductBuildVersion", "raw", "-o", "-", plist],
			XCODE_READ_TIMEOUT_MS
		);
		if (build.success && /^\S+$/.test(build.data.trim())) return ok(build.data.trim());
	}
	const xcode = await run(deps, ["xcodebuild", "-version"], XCODE_READ_TIMEOUT_MS);
	return xcode.success ? parseXcodeBuild(xcode.data) : xcode;
}

/** Per exec (so per process in the CLI, per fake host in tests): profile + runtime → the target read in flight or done. */
const targetMemo = new WeakMap<Exec, Map<string, Promise<Result<GoldenTarget>>>>();

/**
 * Xcode build + the device type / runtime `simctl create` would use for this profile. Memoised per
 * process (16-6): every clone of one claim would read the same thing. A failed read is not kept.
 */
export function readGoldenTarget(deps: GoldenDeps, profile: string, runtime?: string): AsyncResult<GoldenTarget> {
	let memo = targetMemo.get(deps.exec);
	if (!memo) {
		memo = new Map();
		targetMemo.set(deps.exec, memo);
	}
	const key = `${profile}\0${runtime ?? ""}`;
	const known = memo.get(key);
	if (known) return known;
	const read = readTarget(deps, profile, runtime);
	memo.set(key, read);
	void read.then((result) => {
		if (!result.success) memo.delete(key);
	});
	return read;
}

async function readTarget(deps: GoldenDeps, profile: string, runtime?: string): AsyncResult<GoldenTarget> {
	const [target, xcodeBuild] = await Promise.all([
		lookupCreateTarget(deps.exec, profile, runtime, deps.timer),
		readXcodeBuild(deps),
	]);
	if (!target.success) return target;
	if (!xcodeBuild.success) return xcodeBuild;
	return ok({
		profile,
		xcodeBuild: xcodeBuild.data,
		runtimeId: target.data.runtime.identifier,
		runtimeBuild: target.data.runtime.build ?? target.data.runtime.version,
		deviceType: target.data.type.identifier,
	});
}

async function allSims(deps: GoldenDeps): AsyncResult<SimctlSim[]> {
	const out = await simctl(deps, ["list", "devices", "-j"], IOS_TIMEOUTS.listMs);
	return out.success ? parseAllSims(out.data) : out;
}

async function readMigration(deps: GoldenDeps, udid: string): Promise<string> {
	const plist = join(
		deps.env.HOME ?? "~",
		"Library/Developer/CoreSimulator/Devices",
		udid,
		"data/Library/Preferences/com.apple.migration.plist"
	);
	const out = await run(deps, ["plutil", "-convert", "json", "-o", "-", plist]);
	return out.success ? out.data : "";
}

/** `bootstatus -b` can return mid-migration: wait on the migration's own record. */
async function waitMigrated(deps: GoldenDeps, udid: string, runtimeBuild: string): AsyncResult<void> {
	const t = timing(deps);
	const deadline = deps.now() + t.migrationMaxMs;
	while (!migrationDone(await readMigration(deps, udid), runtimeBuild)) {
		if (deps.now() >= deadline)
			return err(`${udid}: data migration did not finish in ${t.migrationMaxMs / 60_000} min`);
		await deps.sleep(t.migrationPollMs);
	}
	return ok(undefined);
}

/** Summed %CPU of every process under this simulator's `launchd_sim`; undefined when not running. */
async function simCpu(deps: GoldenDeps, udid: string): Promise<number | undefined> {
	const list = await run(deps, ["launchctl", "list"]);
	if (!list.success) return undefined;
	const row = list.data
		.split("\n")
		.map((line) => line.split("\t"))
		.find((cols) => cols[2] === `com.apple.CoreSimulator.SimDevice.${udid}`);
	const pid = Number(row?.[0]);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const ps = await run(deps, ["ps", "-axo", "ppid=,pcpu="]);
	if (!ps.success) return undefined;
	let cpu = 0;
	for (const line of ps.data.split("\n")) {
		const [ppid, pcpu] = line.trim().split(/\s+/).map(Number);
		if (ppid === pid) cpu += pcpu ?? 0;
	}
	return cpu;
}

/** A fresh device keeps working for minutes after boot; shut the golden down at rest. Timeout is logged, not fatal. */
async function waitSettled(deps: GoldenDeps, udid: string): AsyncResult<void> {
	const t = timing(deps);
	const samples: number[] = [];
	const deadline = deps.now() + t.settleMaxMs;
	while (deps.now() < deadline) {
		await deps.sleep(t.settleIntervalMs);
		const cpu = await simCpu(deps, udid);
		if (cpu === undefined) return err(`${udid} stopped while settling`);
		samples.push(cpu);
		if (isSettled(samples, t)) return ok(undefined);
	}
	log(
		deps,
		`not settled after ${t.settleMaxMs / 1000}s (last ${samples.slice(-t.window).join(", ")}% CPU) — using it anyway`
	);
	return ok(undefined);
}

/** Shutdown, delete and rename: quick CoreSimulator calls, bounded like a shutdown. */
const MUTATE_TIMEOUT_MS = IOS_TIMEOUTS.shutdownMs;

async function discard(deps: GoldenDeps, udid: string): Promise<void> {
	await simctl(deps, ["shutdown", udid], MUTATE_TIMEOUT_MS);
	await simctl(deps, ["delete", udid], MUTATE_TIMEOUT_MS);
}

/**
 * Recipe 2 (16-7): the driver's `AutomationEnabled` preference lives under `data/`, which `simctl clone`
 * copies, so writing it once here saves every fresh clone the in-sim `defaults write` on its first open.
 */
const AUTOMATION_ENABLED = ["defaults", "write", "com.apple.Accessibility", "AutomationEnabled", "-bool", "true"];

async function buildSteps(deps: GoldenDeps, target: GoldenTarget, udid: string): AsyncResult<void> {
	const t = timing(deps);
	const steps: Array<() => AsyncResult<unknown>> = [
		() => simctl(deps, ["boot", udid], IOS_TIMEOUTS.bootMs),
		() => simctl(deps, ["bootstatus", udid, "-b"], t.bootTimeoutMs),
		() => waitMigrated(deps, udid, target.runtimeBuild),
		() => simctl(deps, ["spawn", udid, ...AUTOMATION_ENABLED], DEFAULTS_WRITE_TIMEOUT_MS),
		() => waitSettled(deps, udid),
		() => simctl(deps, ["shutdown", udid], IOS_TIMEOUTS.shutdownMs),
	];
	for (const step of steps) {
		const result = await step();
		if (!result.success) return result;
	}
	if (!migrationDone(await readMigration(deps, udid), target.runtimeBuild)) {
		return err(`${udid}: migration record missing after shutdown — not promoting it`);
	}
	return ok(undefined);
}

/** create `-wip` → boot → migration done → settled → shutdown → verify → rename. The wip is deleted on failure. */
async function buildGolden(deps: GoldenDeps, target: GoldenTarget, key: string): AsyncResult<EnsuredGolden> {
	const started = deps.now();
	const name = goldenName(target.profile, key);
	if (deps.prewarmHint) {
		log(
			deps,
			`building golden for ${target.profile} (first claim of this profile, ~5 min); prewarm with: warden golden ensure --profile ${target.profile}`
		);
	}
	log(
		deps,
		`building ${name} (${target.deviceType.split(".").pop()}, ${target.runtimeId.split(".").pop()}) — one-time first boot, a few minutes`
	);
	const created = await simctl(
		deps,
		["create", wipName(target.profile, key), target.deviceType, target.runtimeId],
		IOS_TIMEOUTS.createMs
	);
	if (!created.success) return created;
	const udid = created.data.trim();
	const built = await buildSteps(deps, target, udid);
	if (!built.success) {
		await discard(deps, udid);
		return built;
	}
	const renamed = await simctl(deps, ["rename", udid, name], MUTATE_TIMEOUT_MS);
	if (!renamed.success) {
		await discard(deps, udid);
		return renamed;
	}
	log(deps, `${name} ready in ${Math.round((deps.now() - started) / 1000)}s`);
	return ok({ udid, name, built: true });
}

async function deleteSims(deps: GoldenDeps, sims: SimctlSim[]): AsyncResult<SimctlSim[]> {
	for (const sim of sims) {
		log(deps, `deleting ${sim.name} (${sim.udid})`);
		await simctl(deps, ["shutdown", sim.udid], MUTATE_TIMEOUT_MS);
		const deleted = await simctl(deps, ["delete", sim.udid], MUTATE_TIMEOUT_MS);
		if (!deleted.success) return deleted;
	}
	return ok(sims);
}

/** Caller holds the golden lock. */
async function ensureLocked(deps: GoldenDeps, target: GoldenTarget): AsyncResult<EnsuredGolden> {
	const key = goldenKey(target);
	const sims = await allSims(deps);
	if (!sims.success) return sims;
	// an older warden version on this machine may still clone its recipe's golden of this target: keep it
	const plan = planGolden(sims.data, target.profile, key, olderRecipeNames(target.profile, target));
	const pruned = await deleteSims(deps, plan.stale);
	if (!pruned.success) return pruned;
	if (plan.kind === "create") return buildGolden(deps, target, key);
	if (plan.sim.state !== "Shutdown") await simctl(deps, ["shutdown", plan.sim.udid], MUTATE_TIMEOUT_MS);
	if (!migrationDone(await readMigration(deps, plan.sim.udid), target.runtimeBuild)) {
		log(deps, `${plan.sim.name} never finished its data migration — rebuilding`);
		await discard(deps, plan.sim.udid);
		return buildGolden(deps, target, key);
	}
	return ok({ udid: plan.sim.udid, name: plan.sim.name, built: false });
}

function lockDeps(deps: GoldenDeps) {
	return {
		...deps,
		waitMs: timing(deps).lockWaitMs,
		pollMs: GOLDEN_LOCK_POLL_MS,
		log: (line: string) => log(deps, line),
	};
}

/** The golden for this Xcode + runtime + device type, built on first use (minutes, once). */
export async function ensureGolden(deps: GoldenDeps, profile: string, runtime?: string): AsyncResult<EnsuredGolden> {
	const target = await readGoldenTarget(deps, profile, runtime);
	if (!target.success) return target;
	return withBuildLock(lockDeps(deps), GOLDEN_LOCK_KEY, () => ensureLocked(deps, target.data));
}

/** `simctl clone` the golden to `name`; held under the lock so the golden can't be booted, rebuilt or deleted mid-clone. */
export async function cloneFromGolden(
	deps: GoldenDeps,
	profile: string,
	runtime: string | undefined,
	name: string
): AsyncResult<ClonedDevice> {
	const target = await readGoldenTarget(deps, profile, runtime);
	if (!target.success) return target;
	return withBuildLock(lockDeps(deps), GOLDEN_LOCK_KEY, async () => {
		const golden = await ensureLocked(deps, target.data);
		if (!golden.success) return golden;
		const cloned = await simctl(deps, ["clone", golden.data.udid, name], IOS_TIMEOUTS.cloneMs);
		if (!cloned.success) return cloned;
		const udid = cloned.data.trim();
		if (!udid) return err(`simctl clone ${golden.data.name} ${name}: no udid returned`);
		return ok({ udid, name, golden: golden.data.name, runtimeId: target.data.runtimeId });
	});
}

/** `warden-golden-<profile>-<key>[-r<recipe>][-wip]` → profile. */
function goldenProfile(name: string): string | undefined {
	return new RegExp(`^${GOLDEN_PREFIX}-(.+)-[0-9a-f]{10}(-r\\d+)?(-wip)?$`).exec(name)?.[1];
}

/** Every golden on the machine (all runtimes, including unavailable). */
export async function listGoldens(deps: GoldenDeps): AsyncResult<SimctlSim[]> {
	const sims = await allSims(deps);
	return sims.success ? ok(sims.data.filter((s) => goldenProfile(s.name) !== undefined)) : sims;
}

/**
 * Delete stale goldens (not current for their profile's latest runtime, older recipes included), or
 * every golden with `all`. A newer recipe's golden (another warden version's) is kept without `all`.
 */
export async function pruneGoldens(deps: GoldenDeps, opts: { all: boolean }): AsyncResult<SimctlSim[]> {
	return withBuildLock(lockDeps(deps), GOLDEN_LOCK_KEY, async () => {
		const goldens = await listGoldens(deps);
		if (!goldens.success) return goldens;
		if (opts.all) return deleteSims(deps, goldens.data);
		const stale: SimctlSim[] = [];
		const profiles = new Set(goldens.data.flatMap((s) => goldenProfile(s.name) ?? []));
		for (const profile of profiles) {
			const target = await readGoldenTarget(deps, profile);
			const mine = goldens.data.filter((s) => goldenProfile(s.name) === profile);
			stale.push(...(target.success ? planGolden(mine, profile, goldenKey(target.data)).stale : mine));
		}
		return deleteSims(deps, stale);
	});
}
