import { dirname, join } from "node:path";
import type { A11yAuditConfig } from "@delacour/warden-core/a11y/a11y.config";
import type { ConditionsConfig } from "@delacour/warden-core/conditions/conditions.config";
import type { Platform } from "@delacour/warden-core/types";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { sourceDirFromCliPath } from "../update/build-info";

/**
 * The built-in spec runner: `bun test --preload @delacour/warden-e2e/preload <spec files>`. Pure
 * argv / env / lookup helpers; `commands/e2e.ts` wires them into the batch jobs.
 */

/** `bun test`'s own per-test timeout sits this far past the spec's, so the spec's deadline error wins. */
const BUN_TIMEOUT_MARGIN_MS = 30_000;

export type RunnerArgvOptions = {
	bun: string;
	/** resolved `@delacour/warden-e2e/preload` */
	preload: string;
	/** absolute paths of the spec files to run */
	specPaths: readonly string[];
	/** the spec's per-test timeout */
	timeoutMs: number;
	junitPath?: string | undefined;
};

/** argv of one `bun test` process over `specPaths`. */
export function runnerArgv(o: RunnerArgvOptions): string[] {
	return [
		o.bun,
		"test",
		"--preload",
		o.preload,
		"--timeout",
		String(o.timeoutMs + BUN_TIMEOUT_MARGIN_MS),
		...(o.junitPath !== undefined ? ["--reporter=junit", "--reporter-outfile", o.junitPath] : []),
		...o.specPaths,
	];
}

/**
 * `WARDEN_BUN`, else warden's own executable: a `bun build --compile` binary run with `BUN_BE_BUN=1` (`specEnv`)
 * is the full bun CLI, `bun test` included, so the specs need no bun install. From source `execPath` is bun.
 */
export function findBun(env: Readonly<Record<string, string | undefined>>, execPath: string): string {
	const set = env.WARDEN_BUN;
	return set !== undefined && set !== "" ? set : execPath;
}

/**
 * Specs → at most `n` shards, round-robin by sorted id (spec `i` goes to shard `i % n`): the same
 * specs always land together, whatever order they were selected in. No specs, no shards.
 */
export function shardSpecs<T extends { id: string }>(specs: readonly T[], n: number): T[][] {
	const sorted = [...specs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const count = Math.min(Math.max(1, n), sorted.length);
	const shards: T[][] = Array.from({ length: count }, () => []);
	sorted.forEach((spec, i) => {
		shards[i % count]?.push(spec);
	});
	return shards;
}

/** The hidden `warden` subcommand that runs the lease shaping proxy; a compiled warden hands specs `<self> __netproxy` (`WARDEN_NETPROXY_COMMAND`). */
export const NETPROXY_SUBCOMMAND = "__netproxy";

export type SpecEnvOptions = {
	platform: Platform;
	bundleId: string;
	launchArgs: readonly string[];
	/** where this process writes `results.jsonl` and its artifacts */
	out: string;
	timeouts: { timeoutMs: number; actionTimeoutMs: number; assertionTimeoutMs: number };
	specsDir: string;
	/** where `warden-simd` lives (the spec's helper lookup) */
	helperDir: string;
	/** warden's own version: the spec preload refuses to run when `@delacour/warden-e2e` is not the same */
	version: string;
	/** argv that re-runs this warden: `device.perf` shells out to it (`WARDEN_BIN`) */
	bin?: readonly string[] | undefined;
	/** argv that restarts a physical iPhone's runner host, `{udid}` replaced by the session (`WARDEN_IOS_RUNNER_RESTART`) */
	iosRunnerRestart?: readonly string[] | undefined;
	/** `warden e2e --perf`: the captures every attempt records (`WARDEN_PERF`) */
	perf?: readonly string[] | undefined;
	/** the suite's `perf.budgets` (`WARDEN_PERF_BUDGETS`) */
	perfBudgets?: Readonly<Record<string, number>> | undefined;
	/** the suite's `conditions` (`WARDEN_CONDITIONS`): what every spec starts from */
	conditions?: ConditionsConfig | undefined;
	/** argv that runs the shaping proxy when warden is a compiled binary (`WARDEN_NETPROXY_COMMAND`); absent from source */
	netproxyCommand?: readonly string[] | undefined;
	/** the suite's devices are biometrics devices (`WARDEN_BIOMETRICS=1`) */
	biometrics?: boolean | undefined;
	/** the dev client's url scheme (`WARDEN_DEV_CLIENT_SCHEME`): an Android spec opens Metro's url as a deep link on it */
	devClientScheme?: string | undefined;
	/** the suite's `a11y` (`WARDEN_A11Y_AUDIT`): the defaults `device.a11yAudit()` / `toPassA11yAudit()` judge by */
	a11yAudit?: A11yAuditConfig | undefined;
	/** iOS apps launch with the injected library (`WARDEN_A11Y=1`) */
	a11y?: boolean | undefined;
};

/**
 * The env contract of one spec process (the per-device `WARDEN_UDID` etc. come from batch). `BUN_BE_BUN=1` makes a
 * compiled warden act as bun (`findBun`); bun itself ignores it, and the spec preload drops it again.
 */
export function specEnv(o: SpecEnvOptions): Record<string, string> {
	return {
		[ENV_NAMES.platform]: o.platform,
		[ENV_NAMES.bundleId]: o.bundleId,
		[ENV_NAMES.launchArgs]: JSON.stringify(o.launchArgs),
		[ENV_NAMES.out]: o.out,
		[ENV_NAMES.timeout]: String(o.timeouts.timeoutMs),
		[ENV_NAMES.actionTimeout]: String(o.timeouts.actionTimeoutMs),
		[ENV_NAMES.assertionTimeout]: String(o.timeouts.assertionTimeoutMs),
		[ENV_NAMES.specsDir]: o.specsDir,
		[ENV_NAMES.helperDir]: o.helperDir,
		[ENV_NAMES.version]: o.version,
		...(o.bin === undefined ? {} : { [ENV_NAMES.bin]: JSON.stringify(o.bin) }),
		...(o.iosRunnerRestart === undefined ? {} : { [ENV_NAMES.iosRunnerRestart]: JSON.stringify(o.iosRunnerRestart) }),
		...(o.perf === undefined ? {} : { [ENV_NAMES.perf]: o.perf.join(",") }),
		...(o.perfBudgets === undefined || Object.keys(o.perfBudgets).length === 0
			? {}
			: { [ENV_NAMES.perfBudgets]: JSON.stringify(o.perfBudgets) }),
		...(o.conditions === undefined || Object.keys(o.conditions).length === 0
			? {}
			: { [ENV_NAMES.conditions]: JSON.stringify(o.conditions) }),
		...(o.netproxyCommand === undefined ? {} : { [ENV_NAMES.netproxyCommand]: JSON.stringify(o.netproxyCommand) }),
		...(o.biometrics === true ? { [ENV_NAMES.biometrics]: "1" } : {}),
		...(o.a11yAudit === undefined ? {} : { [ENV_NAMES.a11yAudit]: JSON.stringify(o.a11yAudit) }),
		...(o.devClientScheme === undefined ? {} : { [ENV_NAMES.devClientScheme]: o.devClientScheme }),
		...(o.a11y === true ? { [ENV_NAMES.a11y]: "1" } : {}),
		BUN_BE_BUN: "1",
	};
}

/**
 * Where `warden-simd` sits for the spec processes (`WARDEN_HELPER_DIR`): next to the compiled
 * binary, or the helper's build output when warden runs from source (`main` = `apps/cli/src/cli.ts`).
 */
export function helperDir(main: string, execPath: string): string {
	const compiled = main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
	return compiled ? dirname(execPath) : join(sourceDirFromCliPath(main), "packages/e2e/native/dist");
}

const PERF_CAPTURES = ["all", "js", "react", "native", "metrics", "frames", "logs"] as const;

/**
 * `--perf` / `--perf=react,js`: the captures each attempt records. Bare `--perf` is warden's default set (metrics,
 * frames, logs: cheap, observe-only). `all` is every capture.
 */
export function parsePerfFlag(raw: string | boolean | undefined): Result<string[] | undefined> {
	if (raw === undefined || raw === false) return ok(undefined);
	if (raw === true || raw.trim() === "") return ok([]);
	const names = raw
		.split(",")
		.map((n) => n.trim())
		.filter((n) => n !== "");
	const unknown = names.find((n) => !(PERF_CAPTURES as readonly string[]).includes(n));
	if (unknown !== undefined) return err(`--perf: unknown capture "${unknown}" (${PERF_CAPTURES.join(", ")})`);
	return ok(names);
}
