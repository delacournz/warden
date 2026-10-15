import { dirname, join } from "node:path";
import type { Platform } from "@delacour/warden-core/types";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { sourceDirFromCliPath } from "../update/build-info";

/**
 * The built-in spec runner: `bun test --preload @delacour/warden-e2e/preload <flow files>`. Pure
 * argv / env / lookup helpers; `commands/e2e.ts` wires them into the batch jobs.
 */

/** `bun test`'s own per-test timeout sits this far past the spec's, so the spec's deadline error wins. */
const BUN_TIMEOUT_MARGIN_MS = 30_000;

export type RunnerArgvOptions = {
	bun: string;
	/** resolved `@delacour/warden-e2e/preload` */
	preload: string;
	/** absolute paths of the flow files to run */
	flowPaths: readonly string[];
	/** the spec's per-test timeout */
	timeoutMs: number;
	junitPath?: string | undefined;
};

/** argv of one `bun test` process over `flowPaths`. */
export function runnerArgv(o: RunnerArgvOptions): string[] {
	return [
		o.bun,
		"test",
		"--preload",
		o.preload,
		"--timeout",
		String(o.timeoutMs + BUN_TIMEOUT_MARGIN_MS),
		...(o.junitPath !== undefined ? ["--reporter=junit", "--reporter-outfile", o.junitPath] : []),
		...o.flowPaths,
	];
}

/** `WARDEN_BUN`, else `bun` on PATH. */
export function findBun(
	env: Readonly<Record<string, string | undefined>>,
	which: (cmd: string) => string | null | undefined
): Result<string> {
	const set = env.WARDEN_BUN;
	if (set !== undefined && set !== "") return ok(set);
	const found = which("bun");
	return found ? ok(found) : err("bun >= 1.3 is required on PATH (or set WARDEN_BUN)");
}

/** `@delacour/warden-e2e/preload` as the suite's project resolves it (`resolve` throws when it can't). */
export function findPreload(cwd: string, resolve: (specifier: string, from: string) => string): Result<string> {
	try {
		return ok(resolve("@delacour/warden-e2e/preload", cwd));
	} catch {
		return err("bun add -d @delacour/warden-e2e");
	}
}

/**
 * Flows → at most `n` shards, round-robin by sorted id (flow `i` goes to shard `i % n`): the same
 * flows always land together, whatever order they were selected in. No flows, no shards.
 */
export function shardFlows<T extends { id: string }>(flows: readonly T[], n: number): T[][] {
	const sorted = [...flows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const count = Math.min(Math.max(1, n), sorted.length);
	const shards: T[][] = Array.from({ length: count }, () => []);
	sorted.forEach((flow, i) => {
		shards[i % count]?.push(flow);
	});
	return shards;
}

export type SpecEnvOptions = {
	platform: Platform;
	bundleId: string;
	launchArgs: readonly string[];
	/** where this process writes `results.jsonl` and its artifacts */
	out: string;
	timeouts: { timeoutMs: number; actionTimeoutMs: number; assertionTimeoutMs: number };
	flowsDir: string;
	/** where `warden-simd` lives (the spec's helper lookup) */
	helperDir: string;
	/** warden's own version: the spec preload warns when `@delacour/warden-e2e` is not the same */
	version: string;
};

/** The env contract of one spec process (the per-device `WARDEN_UDID` etc. come from batch). */
export function specEnv(o: SpecEnvOptions): Record<string, string> {
	return {
		[ENV_NAMES.platform]: o.platform,
		[ENV_NAMES.bundleId]: o.bundleId,
		[ENV_NAMES.launchArgs]: JSON.stringify(o.launchArgs),
		[ENV_NAMES.out]: o.out,
		[ENV_NAMES.timeout]: String(o.timeouts.timeoutMs),
		[ENV_NAMES.actionTimeout]: String(o.timeouts.actionTimeoutMs),
		[ENV_NAMES.assertionTimeout]: String(o.timeouts.assertionTimeoutMs),
		[ENV_NAMES.flowsDir]: o.flowsDir,
		[ENV_NAMES.helperDir]: o.helperDir,
		[ENV_NAMES.version]: o.version,
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
