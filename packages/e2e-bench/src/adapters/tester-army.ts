import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { ExecResult } from "../harness/exec";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type RunContext,
	type TestResult,
} from "./adapter.types";
import { parseTesterReport, type TesterNative } from "./parse/tester-report";

/** Upper bound for the whole `e2e run` process. */
const SUITE_TIMEOUT_MS = 20 * 60_000;
/** The `e2e` package refuses to start below this (`engines.node`: `^22.22.3 || >=24.8.0`). */
export const NODE_RANGE_HINT = "^22.22.3 || >=24.8.0";
const NODE_INSTALL_HINT = "nvm install 24  (or set BENCH_NODE_BIN to a Node >=24.8 bin dir)";

/** Everything impure the adapter touches besides spawning; tests replace it. */
export type TesterArmyDeps = {
	exists: (path: string) => boolean;
	readText: (path: string) => string | undefined;
	home: () => string;
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

export const defaultTesterArmyDeps: TesterArmyDeps = {
	exists: existsSync,
	readText: readTextIfPresent,
	home: homedir,
};

/**
 * True when `version` (`v22.22.2` or `22.22.2`) is outside the range `e2e` requires. An unparsable
 * version counts as too old so the adapter falls back to the pinned Node instead of failing in the CLI.
 */
export function nodeTooOld(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (match === null) return true;
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (major === 22) return minor < 22 || (minor === 22 && patch < 3);
	if (major === 24) return minor < 8;
	return major < 24;
}

/** `$BENCH_NODE_BIN` or the nvm Node 24 the repo's notes pin. */
export function nodeBinDir(env: RunContext["env"], home: string): string {
	return env.BENCH_NODE_BIN ?? join(home, ".nvm/versions/node/v24.19.0/bin");
}

/** The `PATH` with `nodeBin` first, so `e2e`'s `#!/usr/bin/env node` finds the newer Node. */
export function nodePath(env: RunContext["env"], nodeBin: string): string {
	const current = env.PATH ?? "";
	return current === "" ? nodeBin : `${nodeBin}:${current}`;
}

/** Where `e2e run` writes, relative to the suite dir: `--output` must stay inside the project root. */
export const SUITE_OUTPUT = ".bench-out";

/** `bunx e2e run …`: list for the log, junit beside `report.json` (always written), no retries unless asked. */
export function testerArmyArgv(o: { retries: number }): string[] {
	return ["e2e", "run", "--reporter", "list,junit", "--output", SUITE_OUTPUT, "--retries", String(o.retries)];
}

/**
 * The bundled agent-device keeps its daemon and Apple runner under this directory. It is not the default
 * `~/.agent-device`: a global agent-device (another version) owns that daemon and the two refuse to share it.
 */
export function stateDirOf(env: RunContext["env"], home: string): string {
	return env.BENCH_TESTER_ARMY_STATE_DIR ?? join(home, ".agent-device-bench/tester-army");
}

/** The device the suite's `e2e.config.ts` reads, and the private agent-device state dir. */
export function testerArmyEnv(ctx: RunContext, path: string, stateDir: string): Record<string, string | undefined> {
	return {
		...ctx.env,
		PATH: path,
		BENCH_UDID: ctx.udid,
		BENCH_PLATFORM: ctx.platform,
		AGENT_DEVICE_STATE_DIR: stateDir,
	};
}

const suiteDirOf = (ctx: RunContext): string => join(ctx.packageRoot, "suites/tester-army");

/** `version` of `node_modules/<name>/package.json`, searched from `start` upward (bun hoists to the repo root). */
export function packageVersion(deps: TesterArmyDeps, start: string, name: string): string | undefined {
	let dir = start;
	for (;;) {
		const text = deps.readText(join(dir, "node_modules", name, "package.json"));
		if (text !== undefined) {
			try {
				const raw: unknown = JSON.parse(text);
				if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string")
					return raw.version;
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

type NodeChoice = { ok: true; version: string; path: string; viaPinned: boolean } | { ok: false; reason: string };

async function nodeVersionOn(ctx: RunContext, path: string): Promise<string | undefined> {
	const ran = await ctx.exec.run("node", ["-v"], { env: { ...ctx.env, PATH: path } });
	return ran.code === 0 ? ran.stdout.trim() : undefined;
}

/** The default Node when it is new enough, else the pinned one; never a Node `e2e` would refuse. */
async function chooseNode(ctx: RunContext, deps: TesterArmyDeps): Promise<NodeChoice> {
	const plain = ctx.env.PATH ?? "";
	const current = await nodeVersionOn(ctx, plain);
	if (current !== undefined && !nodeTooOld(current))
		return { ok: true, version: current, path: plain, viaPinned: false };
	const pinnedBin = nodeBinDir(ctx.env, deps.home());
	const path = nodePath(ctx.env, pinnedBin);
	const pinned = await nodeVersionOn(ctx, path);
	if (pinned !== undefined && !nodeTooOld(pinned)) return { ok: true, version: pinned, path, viaPinned: true };
	return {
		ok: false,
		reason: `node ${current ?? "(missing)"} is outside ${NODE_RANGE_HINT} and ${pinnedBin} has ${pinned ?? "no node"}`,
	};
}

async function doctor(ctx: RunContext, deps: TesterArmyDeps): Promise<Doctor> {
	const e2e = packageVersion(deps, ctx.packageRoot, "e2e");
	if (e2e === undefined) return { ok: false, reason: "e2e is not installed", installHint: "bun install" };
	const mobile = packageVersion(deps, ctx.packageRoot, "@e2e-dev/mobile");
	if (mobile === undefined)
		return { ok: false, reason: "@e2e-dev/mobile is not installed", installHint: "bun install" };
	const node = await chooseNode(ctx, deps);
	if (!node.ok) return { ok: false, reason: node.reason, installHint: NODE_INSTALL_HINT };
	const agentDevice = packageVersion(deps, ctx.packageRoot, "agent-device") ?? "unknown";
	const notes = [
		`@e2e-dev/mobile ${mobile}`,
		`bundled agent-device ${agentDevice}`,
		`node ${node.version}${node.viaPinned ? ` (pinned, ${nodeBinDir(ctx.env, deps.home())})` : ""}`,
	];
	return { ok: true, version: `e2e ${e2e}`, notes };
}

/** `err` is string-only; `run` fails with an `AdapterError`. */
const bad = (error: AdapterError): { success: false; error: AdapterError } => ({ success: false, error });

const tailOf = (ran: ExecResult): string => (ran.stderr || ran.stdout).trim().split("\n").slice(-5).join("\n");

function toTest(m: { id: TestResult["id"]; nativeName: string }, t: TesterNative | undefined): TestResult {
	if (t === undefined) return { id: m.id, nativeName: m.nativeName, status: "missing" };
	return {
		id: m.id,
		nativeName: t.nativeName,
		status: t.status,
		durationMs: t.durationMs,
		steps: t.steps,
		...(t.error !== undefined ? { error: t.error } : {}),
	};
}

/** Maps native tests onto canonical ids; an unmapped name is a parity breach. */
export function toRep(
	ctx: RunContext,
	native: readonly TesterNative[],
	wallMs: number,
	startedAt: string,
	artifacts: NonNullable<TestResult["artifacts"]>
): Result<RepResult, AdapterError> {
	const byName = new Map(native.map((t) => [t.nativeName, t]));
	const joined = joinNative(loadManifest(ctx.packageRoot), "tester-army", native, (id, t) => ({
		id,
		nativeName: t.nativeName,
		status: t.status,
	}));
	if (joined.unmapped.length > 0) return bad(failed(`parity breach: unmapped tests: ${joined.unmapped.join(", ")}`));
	const tests = joined.mapped.map((m) => toTest(m, byName.get(m.nativeName)));
	const withArtifacts = tests.map((t, i) => (i === 0 && artifacts.length > 0 ? { ...t, artifacts } : t));
	return ok({
		index: 1,
		cold: ctx.cold,
		wallMs,
		wallSource: "harness",
		startedAt,
		tests: withArtifacts,
		rawArtifactDir: ctx.outDir,
	});
}

async function run(ctx: RunContext, deps: TesterArmyDeps): Promise<Result<RepResult, AdapterError>> {
	const node = await chooseNode(ctx, deps);
	if (!node.ok) return bad(failed(node.reason));
	ctx.log(`node ${node.version}${node.viaPinned ? " (pinned via BENCH_NODE_BIN)" : ""}`);
	const suiteDir = suiteDirOf(ctx);
	const reportDir = join(ctx.outDir, "report");
	await ctx.exec.run("rm", ["-rf", join(suiteDir, SUITE_OUTPUT)]);
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const ran = await ctx.exec.run("bunx", testerArmyArgv({ retries: ctx.retries }), {
		cwd: suiteDir,
		env: testerArmyEnv(ctx, node.path, stateDirOf(ctx.env, deps.home())),
		timeoutMs: SUITE_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	const wallMs = performance.now() - t0;
	if (ran.spawnError !== undefined) return bad(failed(`bunx e2e: ${ran.spawnError}`));
	if (ran.timedOut) return bad(failed(`e2e run timed out after ${SUITE_TIMEOUT_MS}ms`));
	const copied = await collectOutput(ctx, suiteDir, reportDir);
	if (!copied.success) return bad(failed(copied.error));
	const text = deps.readText(join(reportDir, "report.json"));
	if (text === undefined) {
		const tail = tailOf(ran);
		return bad(failed(`tester.army wrote no report.json (exit ${ran.code})${tail ? `: ${tail}` : ""}`));
	}
	const parsed = parseTesterReport(text);
	if (!parsed.success) return bad(failed(parsed.error));
	const junit = deps.exists(join(reportDir, "junit.xml"));
	return toRep(ctx, parsed.data, wallMs, startedAt, [
		{ kind: "json", path: "report/report.json" },
		...(junit ? [{ kind: "junit" as const, path: "report/junit.xml" }] : []),
	]);
}

/** Moves the run's output out of the suite dir (where `--output` had to be) into the rep's out dir. */
async function collectOutput(ctx: RunContext, suiteDir: string, reportDir: string): Promise<Result<void>> {
	const from = join(suiteDir, SUITE_OUTPUT);
	const made = await ctx.exec.run("mkdir", ["-p", reportDir]);
	if (made.code !== 0) return err(`mkdir ${reportDir}: ${made.stderr.trim()}`);
	const copy = await ctx.exec.run("cp", ["-R", `${from}/.`, reportDir]);
	await ctx.exec.run("rm", ["-rf", from]);
	return copy.code === 0 ? ok(undefined) : err(`copying ${from}: ${copy.stderr.trim() || `exit ${copy.code}`}`);
}

/**
 * Nothing to warm: the bundled agent-device starts its daemon and builds / installs the XCUITest runner
 * on first use, so that cost lands in rep 1 where a user would pay it.
 */
async function prepare(): Promise<Result<void>> {
	return ok(undefined);
}

/**
 * Stops the bundled agent-device daemon of the private state dir (`--clean` also removes the runner
 * processes and leases it owns), then kills any `agent-device` process still running out of this checkout.
 */
async function teardown(ctx: RunContext, deps: TesterArmyDeps): Promise<Result<void>> {
	const node = await chooseNode(ctx, deps);
	const path = node.ok ? node.path : (ctx.env.PATH ?? "");
	const stateDir = stateDirOf(ctx.env, deps.home());
	const stop = await ctx.exec.run("bunx", ["agent-device", "daemon", "stop", "--state-dir", stateDir, "--clean"], {
		cwd: suiteDirOf(ctx),
		env: { ...ctx.env, PATH: path, AGENT_DEVICE_STATE_DIR: stateDir },
		timeoutMs: 60_000,
		onLine: (_s, line) => ctx.log(line),
	});
	await ctx.exec.run("pkill", ["-f", join(ctx.repoRoot, "node_modules/agent-device")]);
	if (stop.spawnError !== undefined) return err(`agent-device daemon stop: ${stop.spawnError}`);
	return ok(undefined);
}

/** The adapter over injectable deps; `testerArmyAdapter` is the real one. */
export function createTesterArmyAdapter(deps: TesterArmyDeps): BenchAdapter {
	return {
		id: "tester-army",
		supports: ["ios", "android"],
		doctor: (ctx) => doctor(ctx, deps),
		prepare,
		run: (ctx) => run(ctx, deps),
		teardown: (ctx) => teardown(ctx, deps),
		residuePatterns: {
			processes: [/agent-device/, /e2e-dev/],
			driverBundleIds: ["com.callstack.agentdevice.runner.uitests.xctrunner"],
			dirs: ["~/.agent-device-bench/tester-army", "~/.e2e"],
		},
	};
}

export const testerArmyAdapter: BenchAdapter = createTesterArmyAdapter(defaultTesterArmyDeps);
