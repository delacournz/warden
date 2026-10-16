import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult, TestResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type Platform,
	type ResiduePatterns,
	type RunContext,
	unsupported,
} from "./adapter.types";
import { type ArgentFlow, parseArgentAggregate } from "./parse/argent-report";

const SUITE_TIMEOUT_MS = 20 * 60_000;
const REPORT_FILE = "argent-report.json";

/**
 * Argent has no per-test retry flag and no model-free retry construct beyond `when:`, so `ctx.retries` is
 * not forwarded; the suite encodes the parity retries in YAML.
 */
export function argentRunArgs(suiteDir: string, udid: string, platform: Platform): string[] {
	return ["flow", "run", suiteDir, "--device", udid, "--platform", platform, "--json"];
}

/**
 * Argent drives an Android emulator through its gRPC endpoint, found via the emulator's
 * `avd/running/pid_*.ini` (`grpc.port` + `grpc.token`). A `-read-only` headless emulator (how warden
 * launches them) registers no such file, so every step fails at the first tap with this message.
 */
const NO_GRPC_RE = /not found among running emulators/;

/** True when every flow failed and each one names the missing gRPC registration. */
export function isNoGrpcRun(flows: readonly ArgentFlow[]): boolean {
	return (
		flows.length > 0 && flows.every((f) => f.status === "failed" && f.error !== undefined && NO_GRPC_RE.test(f.error))
	);
}

/** Maps parsed flows onto the manifest; an unmapped native name is a parity breach. */
export function toTestResults(flows: readonly ArgentFlow[], packageRoot: string): Result<TestResult[], string> {
	const manifest = loadManifest(packageRoot);
	const { mapped, unmapped } = joinNative(manifest, "argent", flows, (id, f) => ({
		id,
		nativeName: f.nativeName,
		status: f.status,
	}));
	if (unmapped.length > 0) return err(`parity breach: unmapped tests: ${unmapped.join(", ")}`);
	const byName = new Map(flows.map((f) => [f.nativeName, f]));
	const tests = mapped.map((m): TestResult => {
		const flow = byName.get(m.nativeName);
		if (flow === undefined) return { id: m.id, nativeName: m.nativeName, status: "missing" };
		return {
			id: m.id,
			nativeName: flow.nativeName,
			status: flow.status,
			durationMs: flow.durationMs,
			steps: flow.steps,
			error: flow.error,
			artifacts: [{ kind: "json", path: REPORT_FILE }],
		};
	});
	return ok(tests);
}

async function doctor(ctx: RunContext): Promise<Doctor> {
	const hint = "bun add -g @swmansion/argent";
	if (ctx.exec.which("argent") === undefined) return { ok: false, reason: "argent is not on PATH", installHint: hint };
	const r = await ctx.exec.run("argent", ["--version"], { env: ctx.env, timeoutMs: 30_000 });
	if (r.code !== 0) return { ok: false, reason: `argent --version exited ${r.code}`, installHint: hint };
	return {
		ok: true,
		version: r.stdout.trim().replace(/^argent\s+v?/i, ""),
		notes: ["the first flow on a cold device installs/starts simulator-server and ax-service (lands in rep 1)"],
	};
}

/** `argent server start --detach` exits 1 when a tool-server already runs, which is fine. */
async function prepare(ctx: RunContext): Promise<Result<void, string>> {
	const r = await ctx.exec.run("argent", ["server", "start", "--detach"], { env: ctx.env, timeoutMs: 60_000 });
	const text = `${r.stdout}\n${r.stderr}`;
	if (r.code === 0 || /already running/i.test(text)) return ok(undefined);
	return err(`argent server start failed (${r.code}): ${text.trim().split("\n").slice(-3).join(" ")}`);
}

async function run(ctx: RunContext): Promise<Result<RepResult, AdapterError>> {
	const suiteDir = join(ctx.packageRoot, "suites/argent");
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const r = await ctx.exec.run("argent", argentRunArgs(suiteDir, ctx.udid, ctx.platform), {
		cwd: suiteDir,
		env: ctx.env,
		timeoutMs: SUITE_TIMEOUT_MS,
		onLine: (stream, line) => {
			if (stream === "stderr") ctx.log(line);
		},
	});
	const wallMs = performance.now() - t0;
	if (r.spawnError !== undefined) return { success: false, error: failed(`argent: ${r.spawnError}`) };
	if (r.timedOut) return { success: false, error: failed(`argent flow run timed out after ${SUITE_TIMEOUT_MS}ms`) };
	mkdirSync(ctx.outDir, { recursive: true });
	writeFileSync(join(ctx.outDir, REPORT_FILE), r.stdout);
	const parsed = parseArgentAggregate(r.stdout);
	if (!parsed.success)
		return {
			success: false,
			error: failed(`${parsed.error}; stderr: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`),
		};
	if (isNoGrpcRun(parsed.data)) {
		return {
			success: false,
			error: unsupported(
				`argent found no gRPC registration for ${ctx.udid} (avd/running/pid_*.ini with grpc.port + grpc.token); warden launches emulators -read-only and headless, which register none`
			),
		};
	}
	const tests = toTestResults(parsed.data, ctx.packageRoot);
	if (!tests.success) return { success: false, error: failed(tests.error) };
	return ok({
		index: 1,
		cold: ctx.cold,
		wallMs,
		wallSource: "harness",
		startedAt,
		tests: tests.data,
		rawArtifactDir: ctx.outDir,
	});
}

/** pids from `pgrep -fl <pattern>` output (`pid command`) whose command line mentions `needle`. */
export function pidsMentioning(pgrepOutput: string, needle: string): number[] {
	const pids: number[] = [];
	for (const line of pgrepOutput.split("\n")) {
		const m = /^(\d+)\s+(.*)$/.exec(line.trim());
		if (m?.[1] !== undefined && m[2]?.includes(needle)) pids.push(Number(m[1]));
	}
	return pids;
}

/**
 * Stops only what this run's device used: that device's simulator-server. The tool-server is shared by every
 * agent's `argent mcp` on the machine, so it is stopped only when no `argent mcp` process is alive.
 */
async function teardown(ctx: RunContext): Promise<Result<void, string>> {
	const sims = await ctx.exec.run("pgrep", ["-fl", "simulator-server"], { env: ctx.env });
	for (const pid of pidsMentioning(sims.stdout, ctx.udid)) await ctx.exec.run("kill", [String(pid)], { env: ctx.env });
	const mcp = await ctx.exec.run("pgrep", ["-f", "argent mcp"], { env: ctx.env });
	if (mcp.code !== 0 || mcp.stdout.trim() === "") {
		await ctx.exec.run("argent", ["server", "stop"], { env: ctx.env, timeoutMs: 30_000 });
	} else ctx.log("argent mcp sessions alive: leaving the shared tool-server running");
	return ok(undefined);
}

export const residuePatterns: ResiduePatterns = {
	processes: [/argent.*(simulator-server|ax-service|tool-server)/, /simulator-server/, /ax-service/],
	driverBundleIds: [],
	dirs: ["~/.argent"],
};

export const argentAdapter: BenchAdapter = {
	id: "argent",
	supports: ["ios", "android"],
	doctor,
	prepare,
	run,
	teardown,
	residuePatterns,
};
