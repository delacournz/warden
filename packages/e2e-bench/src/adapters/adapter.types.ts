import type { AsyncResult, Result } from "@delacour/warden-types/result";
import type { Exec } from "../harness/exec";
import type { CanonicalId, Platform, RepResult, TestResult } from "../results/schema";

export type { CanonicalId, Platform, RepResult, TestResult };

/** The six frameworks, in the order the report lists them. */
export const FRAMEWORK_IDS = ["warden", "maestro", "argent", "agent-device", "tester-army", "detox"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export function isFrameworkId(value: string): value is FrameworkId {
	return (FRAMEWORK_IDS as readonly string[]).includes(value);
}

/** Everything an adapter needs for one phase; the harness builds it per framework and per rep. */
export type RunContext = {
	platform: Platform;
	/** iOS simulator UDID or Android serial */
	udid: string;
	bundleId: string;
	/** the Release `.app` / `.apk` warden built (same for every framework) */
	appPath: string;
	/** `artifacts/<framework>/rep-<n>` (run) or `artifacts/<framework>` (prepare / teardown): the adapter's scratch + output dir */
	outDir: string;
	/** rep 1: driver apps uninstalled and daemons killed before it */
	cold: boolean;
	/** forwarded uniformly to every framework (default 0) */
	retries: number;
	/** the environment child processes get (the adapter may add to it) */
	env: Record<string, string | undefined>;
	exec: Exec;
	/** one line into the phase log */
	log: (line: string) => void;
	/** the package root (`packages/e2e-bench`), where `suites/<framework>` lives */
	packageRoot: string;
	/** the repository root */
	repoRoot: string;
};

/** What `doctor` found: installed and usable, or not (with the exact install command). */
export type Doctor =
	| { ok: true; version: string; notes: string[] }
	| { ok: false; reason: string; installHint: string };

/** Patterns the residue check and the isolation step use to find what a framework leaves behind. */
export type ResiduePatterns = {
	/** matched against `ps -axo pid,ppid,rss,%cpu,command` lines */
	processes: RegExp[];
	/** runner / driver apps installed on the device by the framework (`simctl listapps` / `pm list packages`) */
	driverBundleIds: string[];
	/** directories the framework writes outside the run's out dir (absolute, `~` allowed) */
	dirs: string[];
};

export type BenchAdapter = {
	id: FrameworkId;
	supports: readonly Platform[];
	doctor(ctx: RunContext): Promise<Doctor>;
	/** cold warm-up that is NOT part of a test (install a runner, start a server); measured as `prepareMs` */
	prepare(ctx: RunContext): AsyncResult<void>;
	/** one full suite pass; parses the framework's native output into canonical results */
	run(ctx: RunContext): Promise<Result<RepResult, AdapterError>>;
	/** kill daemons, stop servers; measured as `teardownMs` */
	teardown(ctx: RunContext): AsyncResult<void>;
	residuePatterns: ResiduePatterns;
};

/** `run` failed in a way that means the framework cannot drive this app at all (Detox on RN 0.86). */
export type UnsupportedError = { kind: "unsupported"; reason: string };
export type RunError = { kind: "failed"; message: string };
export type AdapterError = UnsupportedError | RunError;

export const unsupported = (reason: string): UnsupportedError => ({ kind: "unsupported", reason });
export const failed = (message: string): RunError => ({ kind: "failed", message });
