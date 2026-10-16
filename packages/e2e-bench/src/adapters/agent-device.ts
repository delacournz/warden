import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { runOk } from "../harness/exec";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult, StepResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type RunContext,
	type TestResult,
} from "./adapter.types";
import { parseAdTiming } from "./parse/ad-timing";
import { type JunitCase, parseJunit } from "./parse/junit";

/** Upper bound for one whole `agent-device test` pass (8 scripts, ~2 min warm). */
export const AGENT_DEVICE_TIMEOUT_MS = 20 * 60_000;
/** `prepare ios-runner` builds (first ever) or health-checks the XCTest runner; the build alone can take minutes. */
export const AGENT_DEVICE_PREPARE_TIMEOUT_MS = 10 * 60_000;
export const AGENT_DEVICE_INSTALL_HINT = "bun add -g agent-device";

/** Everything impure besides spawning; tests replace it. */
export type AgentDeviceDeps = {
	readText: (path: string) => string | undefined;
	/** names of the entries in `dir` (empty when it does not exist) */
	listDir: (dir: string) => string[];
	mkdir: (dir: string) => void;
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

export const defaultAgentDeviceDeps: AgentDeviceDeps = {
	readText: readTextIfPresent,
	listDir: (dir) => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
	mkdir: (dir) => {
		mkdirSync(dir, { recursive: true });
	},
};

const suiteDir = (ctx: Pick<RunContext, "packageRoot">): string => join(ctx.packageRoot, "suites/agent-device");
const bad = (error: AdapterError): { success: false; error: AdapterError } => ({ success: false, error });

/** The session name every agent-device call of one device shares, so `daemon stop --clean` finds it. */
export const sessionName = (udid: string): string => `bench-${udid}`;

/**
 * `agent-device test` argv. `.ad` scripts carry no `context platform=` header, so `--platform` is deliberately
 * NOT passed: with it, `test` filters out every script lacking platform metadata ("No replay tests matched").
 * The device is pinned by `--udid` (iOS simulator) or `--serial` (Android), which `agent-device` resolves to a
 * platform by itself. `--verbose` makes `test` print per-test step timings; `--retries` is forwarded as is.
 */
export function agentDeviceTestArgv(o: {
	platform: RunContext["platform"];
	udid: string;
	glob: string;
	junitPath: string;
	artifactsDir: string;
	retries: number;
}): string[] {
	return [
		"test",
		o.glob,
		o.platform === "android" ? "--serial" : "--udid",
		o.udid,
		"--session",
		sessionName(o.udid),
		"--reporter",
		`junit:${o.junitPath}`,
		"--artifacts-dir",
		o.artifactsDir,
		"--verbose",
		"--retries",
		String(o.retries),
	];
}

/** `prepare ios-runner` argv (iOS only; Android has no runner to warm). */
export const agentDevicePrepareArgv = (udid: string): string[] => [
	"prepare",
	"ios-runner",
	"--platform",
	"ios",
	"--udid",
	udid,
];

async function doctor(ctx: RunContext): Promise<Doctor> {
	const version = await ctx.exec.run("agent-device", ["--version"]);
	if (version.code !== 0)
		return {
			ok: false,
			reason: "agent-device is not installed or not runnable",
			installHint: AGENT_DEVICE_INSTALL_HINT,
		};
	return { ok: true, version: `agent-device ${version.stdout.trim().split("\n")[0] ?? ""}`.trim(), notes: [] };
}

/**
 * Builds (first ever) or health-checks the XCTest runner on the simulator, so the first script does not pay it;
 * measured as `prepareMs`. It then stops the daemon WITHOUT `--clean`: agent-device documents that the prepare
 * daemon otherwise keeps the prepared runner lease while `test` starts its own daemon. The runner stays installed.
 */
async function prepare(ctx: RunContext): Promise<Result<void>> {
	if (ctx.platform !== "ios") return ok(undefined);
	const prepared = await runOk(ctx.exec, "agent-device", agentDevicePrepareArgv(ctx.udid), {
		env: ctx.env,
		timeoutMs: AGENT_DEVICE_PREPARE_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	if (!prepared.success) return err(prepared.error);
	await ctx.exec.run("agent-device", ["daemon", "stop"], { env: ctx.env });
	return ok(undefined);
}

/** Daemon and runner processes agent-device leaves behind; matched on the `ps` command column. */
export const AGENT_DEVICE_PROCESS_RE = /agent-device.*daemon|AgentDeviceRunner/i;

/** Parses `ps -axo pid=,command=` lines and returns the pids of agent-device daemons / runners. */
export function agentDevicePids(psOutput: string, selfPid: number): number[] {
	const pids: number[] = [];
	for (const line of psOutput.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m?.[1] === undefined || m[2] === undefined) continue;
		const pid = Number(m[1]);
		if (pid !== selfPid && AGENT_DEVICE_PROCESS_RE.test(m[2]) && !m[2].includes("bun test")) pids.push(pid);
	}
	return pids;
}

/** `daemon stop --clean` removes the retained runner processes and leases; then any stray daemon is killed. */
async function teardown(ctx: RunContext): Promise<Result<void>> {
	await ctx.exec.run("agent-device", ["daemon", "stop", "--clean"], { env: ctx.env, timeoutMs: 60_000 });
	const ps = await ctx.exec.run("ps", ["-axo", "pid=,command="]);
	for (const pid of agentDevicePids(ps.stdout, process.pid)) await ctx.exec.run("kill", [String(pid)]);
	return ok(undefined);
}

/** `onboarding-steps-to-sign-in.ad` (what the junit reporter prints) → the manifest's `onboarding-steps-to-sign-in`. */
export const nativeNameOfCase = (caseName: string): string => caseName.replace(/\.ad$/, "");

/**
 * The newest attempt dir of one script: `<artifacts>/<run hash>/<path with / as __>/attempt-N`. The run hash
 * dir is per `test` invocation, so the lexically last one is this rep's; the highest attempt is the final one.
 */
export function findAttemptDir(deps: AgentDeviceDeps, artifactsDir: string, scriptName: string): string | undefined {
	for (const run of deps.listDir(artifactsDir).sort().reverse()) {
		const runDir = join(artifactsDir, run);
		const scriptDir = deps.listDir(runDir).find((d) => d === `${scriptName}.ad` || d.endsWith(`__${scriptName}.ad`));
		if (scriptDir === undefined) continue;
		const attempts = deps
			.listDir(join(runDir, scriptDir))
			.filter((a) => /^attempt-\d+$/.test(a))
			.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
		const last = attempts.at(-1);
		if (last !== undefined) return join(runDir, scriptDir, last);
	}
	return undefined;
}

function stepsFor(deps: AgentDeviceDeps, ctx: RunContext, scriptName: string): { steps?: StepResult[]; path?: string } {
	const dir = findAttemptDir(deps, join(ctx.outDir, "artifacts"), scriptName);
	if (dir === undefined) return {};
	const timing = deps.readText(join(dir, "replay-timing.ndjson"));
	if (timing === undefined) return {};
	const script = deps.readText(join(dir, "replay.ad")) ?? deps.readText(join(suiteDir(ctx), `${scriptName}.ad`)) ?? "";
	return { steps: parseAdTiming(timing, script), path: join(dir, "replay-timing.ndjson").slice(ctx.outDir.length + 1) };
}

function testOf(deps: AgentDeviceDeps, ctx: RunContext, id: TestResult["id"], c: JunitCase): TestResult {
	const { steps, path } = stepsFor(deps, ctx, nativeNameOfCase(c.name));
	return {
		id,
		nativeName: nativeNameOfCase(c.name),
		status: c.status,
		durationMs: c.durationMs,
		...(steps !== undefined ? { steps } : {}),
		...(c.error !== undefined ? { error: c.error } : {}),
		artifacts: [{ kind: "junit", path: "junit.xml" }, ...(path !== undefined ? [{ kind: "json" as const, path }] : [])],
	};
}

/** Canonical rep from the junit cases; an unmapped native name is a parity breach. */
function toRep(
	deps: AgentDeviceDeps,
	ctx: RunContext,
	cases: JunitCase[],
	wallMs: number,
	startedAt: string
): Result<RepResult, AdapterError> {
	const byId = new Map<TestResult["id"], TestResult>();
	const native = cases.map((c) => ({ nativeName: nativeNameOfCase(c.name), junit: c }));
	const joined = joinNative(loadManifest(ctx.packageRoot), "agent-device", native, (id, n) => {
		byId.set(id, testOf(deps, ctx, id, n.junit));
		return { id, nativeName: n.nativeName, status: n.junit.status };
	});
	if (joined.unmapped.length > 0) return bad(failed(`parity breach: unmapped tests: ${joined.unmapped.join(", ")}`));
	const tests: TestResult[] = joined.mapped.map(
		(m) => byId.get(m.id) ?? { id: m.id, nativeName: m.nativeName, status: "missing" }
	);
	return ok({
		index: 1,
		cold: ctx.cold,
		wallMs,
		wallSource: "harness",
		startedAt,
		tests,
		rawArtifactDir: ctx.outDir,
	});
}

function noJunit(
	ran: { code: number; stdout: string; stderr: string },
	detail: string
): Result<RepResult, AdapterError> {
	const tail = `${ran.stderr}\n${ran.stdout}`.trim().split("\n").slice(-5).join("\n");
	return bad(failed(`agent-device test wrote no usable junit (exit ${ran.code}): ${detail}${tail ? `\n${tail}` : ""}`));
}

async function run(ctx: RunContext, deps: AgentDeviceDeps): Promise<Result<RepResult, AdapterError>> {
	const junitPath = join(ctx.outDir, "junit.xml");
	deps.mkdir(ctx.outDir);
	const argv = agentDeviceTestArgv({
		platform: ctx.platform,
		udid: ctx.udid,
		glob: join(suiteDir(ctx), "*.ad"),
		junitPath,
		artifactsDir: join(ctx.outDir, "artifacts"),
		retries: ctx.retries,
	});
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const ran = await ctx.exec.run("agent-device", argv, {
		cwd: ctx.packageRoot,
		env: ctx.env,
		timeoutMs: AGENT_DEVICE_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	const wallMs = performance.now() - t0;
	if (ran.spawnError !== undefined) return bad(failed(`agent-device: ${ran.spawnError}`));
	if (ran.timedOut)
		return bad(failed(`agent-device test exceeded the ${AGENT_DEVICE_TIMEOUT_MS / 60_000} min timeout`));
	const xml = deps.readText(junitPath);
	if (xml === undefined) return noJunit(ran, "junit file missing");
	const parsed = parseJunit(xml);
	if (!parsed.success) return noJunit(ran, parsed.error);
	return toRep(deps, ctx, parsed.data, wallMs, startedAt);
}

/** The adapter over injectable deps; `agentDeviceAdapter` is the real one. */
export function createAgentDeviceAdapter(deps: AgentDeviceDeps): BenchAdapter {
	return {
		id: "agent-device",
		supports: ["ios", "android"],
		doctor,
		prepare,
		run: (ctx) => run(ctx, deps),
		teardown,
		residuePatterns: {
			processes: [/agent-device.*daemon/, /agent-device/],
			driverBundleIds: ["com.callstack.agentdevice.runner.uitests.xctrunner"],
			dirs: ["~/.agent-device"],
		},
	};
}

export const agentDeviceAdapter: BenchAdapter = createAgentDeviceAdapter(defaultAgentDeviceDeps);
