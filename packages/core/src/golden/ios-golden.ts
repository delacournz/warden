/**
 * Side-effect half of golden simulators (see `golden.ts`): build, reuse, clone, prune. All work on
 * goldens runs under one machine-wide warden lease (`golden:ios`), so a build, clone or prune in one
 * process never races another — a clone never sees a half-built or deleted golden.
 */
import { join } from "node:path";
import { buildLock } from "@delacour/warden-builds/lock";
import { GOLDEN_PREFIX } from "@delacour/warden-providers/golden-name";
import { BoundedExec, type Timer, timers } from "@delacour/warden-providers/health";
import { IOS_TIMEOUTS, Simctl } from "@delacour/warden-providers/ios";
import { type SimctlSim, simctlListParser } from "@delacour/warden-providers/simctl-list";
import { type Exec, type ExecOptions, execErrors } from "@delacour/warden-runtime/exec";
import { xcodeReader } from "@delacour/warden-runtime/xcode";
import type { PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { GOLDEN_RECIPE, type GoldenInputs, goldenImages } from "./golden";

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

/** Shutdown, delete and rename: quick CoreSimulator calls, bounded like a shutdown. */
const MUTATE_TIMEOUT_MS = IOS_TIMEOUTS.shutdownMs;

/**
 * Recipe 2 (16-7): the driver's `AutomationEnabled` preference lives under `data/`, which `simctl clone`
 * copies, so writing it once here saves every fresh clone the in-sim `defaults write` on its first open.
 */
const AUTOMATION_ENABLED = ["defaults", "write", "com.apple.Accessibility", "AutomationEnabled", "-bool", "true"];

/** Per exec (so per process in the CLI, per fake host in tests): profile + runtime → the target read in flight or done. */
const targetMemo = new WeakMap<Exec, Map<string, Promise<Result<GoldenTarget>>>>();

/** Golden simulators: build, reuse, clone, list and prune, all under the machine-wide `golden:ios` lease. */
export class IosGolden {
	constructor(private readonly deps: GoldenDeps) {}

	/**
	 * Xcode build + the device type / runtime `simctl create` would use for this profile. Memoised per
	 * process (16-6): every clone of one claim would read the same thing. A failed read is not kept.
	 */
	readTarget(profile: string, runtime?: string): AsyncResult<GoldenTarget> {
		let memo = targetMemo.get(this.deps.exec);
		if (!memo) {
			memo = new Map();
			targetMemo.set(this.deps.exec, memo);
		}
		const key = `${profile}\0${runtime ?? ""}`;
		const known = memo.get(key);
		if (known) return known;
		const read = this.lookupTarget(profile, runtime);
		memo.set(key, read);
		void read.then((result) => {
			if (!result.success) memo.delete(key);
		});
		return read;
	}

	/** The golden for this Xcode + runtime + device type, built on first use (minutes, once). */
	async ensure(profile: string, runtime?: string): AsyncResult<EnsuredGolden> {
		const target = await this.readTarget(profile, runtime);
		if (!target.success) return target;
		return buildLock.hold(this.lockDeps(), GOLDEN_LOCK_KEY, () => this.ensureLocked(target.data));
	}

	/** `simctl clone` the golden to `name`; held under the lock so the golden can't be booted, rebuilt or deleted mid-clone. */
	async cloneFrom(profile: string, runtime: string | undefined, name: string): AsyncResult<ClonedDevice> {
		const target = await this.readTarget(profile, runtime);
		if (!target.success) return target;
		return buildLock.hold(this.lockDeps(), GOLDEN_LOCK_KEY, async () => {
			const golden = await this.ensureLocked(target.data);
			if (!golden.success) return golden;
			const cloned = await this.simctl(["clone", golden.data.udid, name], IOS_TIMEOUTS.cloneMs);
			if (!cloned.success) return cloned;
			const udid = cloned.data.trim();
			if (!udid) return resultFactory.err(`simctl clone ${golden.data.name} ${name}: no udid returned`);
			return resultFactory.ok({ udid, name, golden: golden.data.name, runtimeId: target.data.runtimeId });
		});
	}

	/** Every golden on the machine (all runtimes, including unavailable). */
	async list(): AsyncResult<SimctlSim[]> {
		const sims = await this.allSims();
		return sims.success ? resultFactory.ok(sims.data.filter((s) => this.goldenProfile(s.name) !== undefined)) : sims;
	}

	/**
	 * Delete stale goldens (not current for their profile's latest runtime, older recipes included), or
	 * every golden with `all`. A newer recipe's golden (another warden version's) is kept without `all`.
	 */
	async prune(opts: { all: boolean }): AsyncResult<SimctlSim[]> {
		return buildLock.hold(this.lockDeps(), GOLDEN_LOCK_KEY, async () => {
			const goldens = await this.list();
			if (!goldens.success) return goldens;
			if (opts.all) return this.deleteSims(goldens.data);
			const stale: SimctlSim[] = [];
			const profiles = new Set(goldens.data.flatMap((s) => this.goldenProfile(s.name) ?? []));
			for (const profile of profiles) {
				const target = await this.readTarget(profile);
				const mine = goldens.data.filter((s) => this.goldenProfile(s.name) === profile);
				stale.push(
					...(target.success
						? goldenImages.plan(mine, profile, goldenImages.key(target.data)).stale
						: mine.filter((sim) => this.notNewer(sim)))
				);
			}
			return this.deleteSims(stale);
		});
	}

	/** Run `cmd`; with `timeoutMs`, a call still running then is an error (and the process is killed). */
	private async run(cmd: string[], timeoutMs?: number): AsyncResult<string> {
		const { deps } = this;
		const result =
			timeoutMs === undefined
				? await deps.exec(cmd)
				: await new BoundedExec({ exec: deps.exec, timer: deps.timer ?? timers.real }).within(cmd, timeoutMs);
		if (result === undefined)
			return resultFactory.err(new Simctl(deps.exec, deps.timer).timedOutError(cmd, timeoutMs ?? 0));
		return result.exitCode === 0 ? resultFactory.ok(result.stdout) : resultFactory.err(execErrors.format(cmd, result));
	}

	private simctl(args: string[], timeoutMs?: number): AsyncResult<string> {
		return this.run(["xcrun", "simctl", ...args], timeoutMs);
	}

	private timing(): GoldenTiming {
		return { ...DEFAULT_GOLDEN_TIMING, ...this.deps.timing };
	}

	private log(line: string): void {
		this.deps.log?.(`golden: ${line}`);
	}

	/**
	 * The selected Xcode's build (`17F113`): `DEVELOPER_DIR` first, else `xcode-select` (see `readXcode`).
	 * Every spawn is bounded: a timeout reads as exit 124 so `readXcode` falls through or fails.
	 */
	private async readXcodeBuild(): AsyncResult<string> {
		const { deps } = this;
		const timed: Exec = async (cmd, opts) => {
			const within = {
				exec: (c: readonly string[], o?: ExecOptions) => deps.exec(c, { ...opts, ...o }),
				timer: deps.timer ?? timers.real,
			};
			const result = await new BoundedExec(within).within(cmd, XCODE_READ_TIMEOUT_MS);
			return result ?? { exitCode: 124, stdout: "", stderr: `timed out after ${XCODE_READ_TIMEOUT_MS} ms` };
		};
		const xcode = await xcodeReader.read(timed, deps.env);
		return xcode.success ? resultFactory.ok(xcode.data.build) : xcode;
	}

	private async lookupTarget(profile: string, runtime?: string): AsyncResult<GoldenTarget> {
		const { deps } = this;
		const [target, xcodeBuild] = await Promise.all([
			new Simctl(deps.exec, deps.timer).lookupCreateTarget(profile, runtime),
			this.readXcodeBuild(),
		]);
		if (!target.success) return wardenErrors.toText(target);
		if (!xcodeBuild.success) return xcodeBuild;
		return resultFactory.ok({
			profile,
			xcodeBuild: xcodeBuild.data,
			runtimeId: target.data.runtime.identifier,
			runtimeBuild: target.data.runtime.build ?? target.data.runtime.version,
			deviceType: target.data.type.identifier,
		});
	}

	private async allSims(): AsyncResult<SimctlSim[]> {
		const out = await this.simctl(["list", "devices", "-j"], IOS_TIMEOUTS.listMs);
		if (!out.success) return out;
		const sims = simctlListParser.parseAll(out.data);
		return sims.success ? sims : resultFactory.err(sims.error.message);
	}

	private async readMigration(udid: string): Promise<string> {
		const plist = join(
			this.deps.env.HOME ?? "~",
			"Library/Developer/CoreSimulator/Devices",
			udid,
			"data/Library/Preferences/com.apple.migration.plist"
		);
		const out = await this.run(["plutil", "-convert", "json", "-o", "-", plist]);
		return out.success ? out.data : "";
	}

	/** `bootstatus -b` can return mid-migration: wait on the migration's own record. */
	private async waitMigrated(udid: string, runtimeBuild: string): AsyncResult<void> {
		const { deps } = this;
		const t = this.timing();
		const deadline = deps.now() + t.migrationMaxMs;
		while (!goldenImages.migrationDone(await this.readMigration(udid), runtimeBuild)) {
			if (deps.now() >= deadline)
				return resultFactory.err(`${udid}: data migration did not finish in ${t.migrationMaxMs / 60_000} min`);
			await deps.sleep(t.migrationPollMs);
		}
		return resultFactory.ok(undefined);
	}

	/** Summed %CPU of `rootPids` and all their descendants. */
	private treeCpu(rows: Array<{ pid: number; ppid: number; pcpu: number }>, rootPids: number[]): number {
		const inTree = new Set(rootPids);
		let grew = true;
		while (grew) {
			grew = false;
			for (const row of rows) {
				if (!inTree.has(row.pid) && inTree.has(row.ppid)) {
					inTree.add(row.pid);
					grew = true;
				}
			}
		}
		return rows.filter((row) => inTree.has(row.pid)).reduce((sum, row) => sum + row.pcpu, 0);
	}

	/** No GUI launchd session (EAS worker, ssh, CI): find the sim's `launchd_sim` by udid in the process table instead. */
	private async simCpuFromPs(udid: string): Promise<number | undefined> {
		const ps = await this.run(["ps", "-axo", "pid=,ppid=,pcpu=,command="]);
		if (!ps.success) return undefined;
		const rows = ps.data.split("\n").flatMap((line) => {
			const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
			return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), command: m[4] ?? "" }] : [];
		});
		const roots = rows.filter((row) => row.command.includes("launchd_sim") && row.command.includes(udid));
		return this.treeCpu(
			rows,
			roots.map((row) => row.pid)
		);
	}

	/**
	 * Summed %CPU of every process under this simulator's `launchd_sim`; undefined when the device is not
	 * running. Probe order: `launchctl list` row (GUI session) → if absent, `simctl list` confirms the device
	 * is booted (Shutdown or missing = stopped) → CPU from `ps` by the udid on `launchd_sim`'s command line.
	 * A booted device with no `launchd_sim` visible reads as 0 % (settled): nothing to wait for.
	 */
	private async simCpu(udid: string): Promise<number | undefined> {
		const list = await this.run(["launchctl", "list"]);
		const row = list.success
			? list.data
					.split("\n")
					.map((line) => line.split("\t"))
					.find((cols) => cols[2] === `com.apple.CoreSimulator.SimDevice.${udid}`)
			: undefined;
		const pid = Number(row?.[0]);
		if (!Number.isInteger(pid) || pid <= 0) {
			const sims = await this.allSims();
			if (!sims.success || sims.data.find((sim) => sim.udid === udid)?.state !== "Booted") return undefined;
			return (await this.simCpuFromPs(udid)) ?? 0;
		}
		const ps = await this.run(["ps", "-axo", "ppid=,pcpu="]);
		if (!ps.success) return undefined;
		let cpu = 0;
		for (const line of ps.data.split("\n")) {
			const [ppid, pcpu] = line.trim().split(/\s+/).map(Number);
			if (ppid === pid) cpu += pcpu ?? 0;
		}
		return cpu;
	}

	/** A fresh device keeps working for minutes after boot; shut the golden down at rest. Timeout is logged, not fatal. */
	private async waitSettled(udid: string): AsyncResult<void> {
		const { deps } = this;
		const t = this.timing();
		const samples: number[] = [];
		const deadline = deps.now() + t.settleMaxMs;
		while (deps.now() < deadline) {
			await deps.sleep(t.settleIntervalMs);
			const cpu = await this.simCpu(udid);
			if (cpu === undefined) return resultFactory.err(`${udid} stopped while settling`);
			samples.push(cpu);
			if (goldenImages.isSettled(samples, t)) return resultFactory.ok(undefined);
		}
		this.log(
			`not settled after ${t.settleMaxMs / 1000}s (last ${samples.slice(-t.window).join(", ")}% CPU) — using it anyway`
		);
		return resultFactory.ok(undefined);
	}

	private async discard(udid: string): Promise<void> {
		await this.simctl(["shutdown", udid], MUTATE_TIMEOUT_MS);
		await this.simctl(["delete", udid], MUTATE_TIMEOUT_MS);
	}

	private async buildSteps(target: GoldenTarget, udid: string): AsyncResult<void> {
		const t = this.timing();
		const steps: Array<() => AsyncResult<unknown>> = [
			() => this.simctl(["boot", udid], IOS_TIMEOUTS.bootMs),
			() => this.simctl(["bootstatus", udid, "-b"], t.bootTimeoutMs),
			() => this.waitMigrated(udid, target.runtimeBuild),
			() => this.simctl(["spawn", udid, ...AUTOMATION_ENABLED], DEFAULTS_WRITE_TIMEOUT_MS),
			() => this.waitSettled(udid),
			() => this.simctl(["shutdown", udid], IOS_TIMEOUTS.shutdownMs),
		];
		for (const step of steps) {
			const result = await step();
			if (!result.success) return result;
		}
		if (!goldenImages.migrationDone(await this.readMigration(udid), target.runtimeBuild)) {
			return resultFactory.err(`${udid}: migration record missing after shutdown — not promoting it`);
		}
		return resultFactory.ok(undefined);
	}

	/** create `-wip` → boot → migration done → settled → shutdown → verify → rename. The wip is deleted on failure. */
	private async build(target: GoldenTarget, key: string): AsyncResult<EnsuredGolden> {
		const { deps } = this;
		const started = deps.now();
		const name = goldenImages.name(target.profile, key);
		if (deps.prewarmHint) {
			this.log(
				`building golden for ${target.profile} (first claim of this profile, ~5 min); prewarm with: warden golden ensure --profile ${target.profile}`
			);
		}
		this.log(
			`building ${name} (${target.deviceType.split(".").pop()}, ${target.runtimeId.split(".").pop()}) — one-time first boot, a few minutes`
		);
		const created = await this.simctl(
			["create", goldenImages.wipName(target.profile, key), target.deviceType, target.runtimeId],
			IOS_TIMEOUTS.createMs
		);
		if (!created.success) return created;
		const udid = created.data.trim();
		const built = await this.buildSteps(target, udid);
		if (!built.success) {
			await this.discard(udid);
			return built;
		}
		const renamed = await this.simctl(["rename", udid, name], MUTATE_TIMEOUT_MS);
		if (!renamed.success) {
			await this.discard(udid);
			return renamed;
		}
		this.log(`${name} ready in ${Math.round((deps.now() - started) / 1000)}s`);
		return resultFactory.ok({ udid, name, built: true });
	}

	private async deleteSims(sims: SimctlSim[]): AsyncResult<SimctlSim[]> {
		for (const sim of sims) {
			this.log(`deleting ${sim.name} (${sim.udid})`);
			await this.simctl(["shutdown", sim.udid], MUTATE_TIMEOUT_MS);
			const deleted = await this.simctl(["delete", sim.udid], MUTATE_TIMEOUT_MS);
			if (!deleted.success) return deleted;
		}
		return resultFactory.ok(sims);
	}

	/** Caller holds the golden lock. */
	private async ensureLocked(target: GoldenTarget): AsyncResult<EnsuredGolden> {
		const key = goldenImages.key(target);
		const sims = await this.allSims();
		if (!sims.success) return sims;
		// an older warden version on this machine may still clone its recipe's golden of this target: keep it
		const plan = goldenImages.plan(
			sims.data,
			target.profile,
			key,
			goldenImages.olderRecipeNames(target.profile, target)
		);
		const pruned = await this.deleteSims(plan.stale);
		if (!pruned.success) return pruned;
		if (plan.kind === "create") return this.build(target, key);
		if (plan.sim.state !== "Shutdown") await this.simctl(["shutdown", plan.sim.udid], MUTATE_TIMEOUT_MS);
		if (!goldenImages.migrationDone(await this.readMigration(plan.sim.udid), target.runtimeBuild)) {
			this.log(`${plan.sim.name} never finished its data migration — rebuilding`);
			await this.discard(plan.sim.udid);
			return this.build(target, key);
		}
		return resultFactory.ok({ udid: plan.sim.udid, name: plan.sim.name, built: false });
	}

	private lockDeps() {
		return {
			...this.deps,
			waitMs: this.timing().lockWaitMs,
			pollMs: GOLDEN_LOCK_POLL_MS,
			log: (line: string) => this.log(line),
		};
	}

	/** `warden-golden-<profile>-<key>[-r<recipe>][-wip]` → profile. */
	private goldenProfile(name: string): string | undefined {
		return new RegExp(`^${GOLDEN_PREFIX}-(.+)-[0-9a-f]{10}(-r\\d+)?(-wip)?$`).exec(name)?.[1];
	}

	/** Not a newer recipe's golden (another warden version's): `-r<recipe>` at most ours, no suffix being recipe 1. */
	private notNewer(sim: SimctlSim): boolean {
		return Number(/-r(\d+)(-wip)?$/.exec(sim.name)?.[1] ?? 1) <= GOLDEN_RECIPE;
	}
}
