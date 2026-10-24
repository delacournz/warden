import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { androidTools } from "@delacour/warden-core/providers/android";
import { type LeaksSummary, parseLeaks, parseVmmap, type VmmapSummary } from "@delacour/warden-perf/metrics/ios-memory";
import { type Meminfo, parseMeminfo } from "@delacour/warden-perf/metrics/meminfo";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { appPid } from "./app-process";
import type { PerfTarget } from "./device";
import { artifactDirFor } from "./metrics-out";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfMemoryOptions = PerfOptionValues & { snapshot?: boolean };

/** Waits `ms`; tests inject one that does not. */
export type MemoryIo = { sleep: (ms: number) => Promise<void> };

const realIo: MemoryIo = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

const KB_PER_MB = 1024;
const mb = (kb: number): string => `${(kb / KB_PER_MB).toFixed(1)} MB`;
/** How long `am dumpheap` may take to finish writing the file, and how often it is looked at. */
const DUMP_WAIT_MS = 60_000;
const DUMP_POLL_MS = 500;
const SNAPSHOT_TIMEOUT_MS = 120_000;

type Ctx = { ctx: CommandContext; target: PerfTarget; app: string };

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

const notRunning = (target: PerfTarget, app: string): UiError =>
	uiError("app_not_found", `${app} is not running on ${target.udid}`, {
		hint: "launch the app first (warden ui open <app>)",
	});

function categoriesText(info: Meminfo): string[] {
	return info.categories.map((c) => `  ${c.name.padEnd(14)} ${mb(c.pssKb)}`);
}

function infoFor(target: PerfTarget): UiSuccess["device"] {
	return { udid: target.udid, platform: target.platform, ...(target.name !== undefined ? { name: target.name } : {}) };
}

// ---------------------------------------------------------------------------------------------- Android

async function androidMeminfo({ ctx, target, app }: Ctx): Promise<Result<Meminfo, UiError>> {
	const res = await ctx.exec([androidTools(ctx.env).adb, "-s", target.udid, "shell", "dumpsys", "meminfo", app], {
		timeoutMs: 15_000,
	});
	const info = res.exitCode === 0 ? parseMeminfo(res.stdout) : undefined;
	return info === undefined ? fail(notRunning(target, app)) : ok(info);
}

/** `am dumpheap` refuses apps that are neither debuggable nor profileable. */
const NOT_DEBUGGABLE = /not debuggable|SecurityException|not profileable/i;

async function dumpHeap(
	{ ctx, target, app }: Ctx,
	outDir: string,
	io: MemoryIo
): Promise<Result<{ path: string; bytes: number }, UiError>> {
	const adb = androidTools(ctx.env).adb;
	const shell = (...args: string[]) => ctx.exec([adb, "-s", target.udid, "shell", ...args], { timeoutMs: 15_000 });
	const remote = `/data/local/tmp/warden-${app}-${ctx.now()}.hprof`;
	const local = join(outDir, "native", `${app}-${ctx.now()}.hprof`);
	try {
		await shell("touch", remote);
		await shell("chmod", "666", remote);
		const dump = await shell("am", "dumpheap", app, remote);
		const said = `${dump.stdout}\n${dump.stderr}`;
		if (NOT_DEBUGGABLE.test(said)) {
			return fail(
				uiError("not_profileable", `${app} is not debuggable or profileable, so Android refuses a heap dump`, {
					hint: 'debug build, or <profileable android:shell="true"/> in the manifest (warden perf doctor)',
				})
			);
		}
		if (dump.exitCode !== 0) {
			return fail(uiError("failed", `am dumpheap failed: ${said.trim() || `exit ${dump.exitCode}`}`));
		}
		const bytes = await waitForDump(shell, remote, io);
		if (bytes === undefined) {
			return fail(
				uiError("failed", `the heap dump did not finish within ${DUMP_WAIT_MS / 1000}s`, {
					hint: "retry; a large heap takes longer",
				})
			);
		}
		mkdirSync(join(outDir, "native"), { recursive: true });
		const pulled = await ctx.exec([adb, "-s", target.udid, "pull", remote, local], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
		if (pulled.exitCode !== 0)
			return fail(uiError("failed", `adb pull failed: ${pulled.stderr.trim() || `exit ${pulled.exitCode}`}`));
		return ok({ path: local, bytes });
	} finally {
		await shell("rm", "-f", remote);
	}
}

/** The dump's size once it stops growing (two equal non-zero readings), else undefined after `DUMP_WAIT_MS`. */
async function waitForDump(
	shell: (...args: string[]) => Promise<{ exitCode: number; stdout: string }>,
	remote: string,
	io: MemoryIo
): Promise<number | undefined> {
	let last = -1;
	for (let waited = 0; waited <= DUMP_WAIT_MS; waited += DUMP_POLL_MS) {
		const res = await shell("stat", "-c", "%s", remote);
		const size = res.exitCode === 0 ? Number(res.stdout.trim()) : 0;
		if (Number.isFinite(size) && size > 0 && size === last) return size;
		last = Number.isFinite(size) ? size : 0;
		await io.sleep(DUMP_POLL_MS);
	}
	return undefined;
}

async function androidMemory(
	c: Ctx,
	snapshot: boolean,
	outDir: string,
	io: MemoryIo
): Promise<Result<UiSuccess, UiError>> {
	const info = await androidMeminfo(c);
	if (!info.success) return info;
	const lines = [
		`${c.app} (pid ${info.data.pid ?? "?"}): PSS ${mb(info.data.totalPssKb)}${info.data.totalRssKb === undefined ? "" : `, RSS ${mb(info.data.totalRssKb)}`}`,
		"top categories (PSS):",
		...categoriesText(info.data),
	];
	const result: Record<string, unknown> = { app: c.app, meminfo: info.data };
	if (!snapshot) {
		lines.push("next: warden perf memory --snapshot · warden perf metrics --watch");
		return ok({ device: infoFor(c.target), result, text: lines.join("\n") });
	}
	const heap = await dumpHeap(c, outDir, io);
	if (!heap.success) return heap;
	result.hprof = heap.data;
	lines.push(
		`heap dump: ${heap.data.path} (${mb(heap.data.bytes / 1024)})`,
		"raw .hprof only: open it in Android Studio (Profiler > Load) or convert with hprof-conv for other tools",
		"next: warden perf heap snapshot (Hermes JS heap)"
	);
	return ok({ device: infoFor(c.target), result, text: lines.join("\n") });
}

// ---------------------------------------------------------------------------------------------- iOS

async function simSpawn(c: Ctx, args: string[]) {
	return c.ctx.exec(["xcrun", "simctl", "spawn", c.target.udid, ...args], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
}

function leakFinding(leaks: LeaksSummary): Finding | undefined {
	const top = leaks.types[0];
	if (leaks.leakCount === 0) return undefined;
	return {
		kind: "leak",
		severity: "warn",
		costMs: 0,
		type: top?.type ?? "unknown",
		count: leaks.leakCount,
		evidence: `${leaks.leakCount} leaked allocation${leaks.leakCount === 1 ? "" : "s"} (${leaks.leakedBytes} bytes)${leaks.types.length > 0 ? `: ${leaks.types.map((t) => `${t.type} x${t.count}`).join(", ")}` : ""}`,
		fix: "Open the memgraph in Xcode (Debug Memory Graph) or run `leaks <file> --traceTree=<address>` to see what holds the object.",
		next: [],
	};
}

async function iosMemory(c: Ctx, snapshot: boolean, outDir: string): Promise<Result<UiSuccess, UiError>> {
	const pid = await appPid(c.ctx, { platform: "ios", id: c.target.udid }, c.app);
	if (pid === undefined) return fail(notRunning(c.target, c.app));
	const vm = await simSpawn(c, ["vmmap", "--summary", String(pid)]);
	const vmmap: VmmapSummary | undefined = vm.exitCode === 0 ? parseVmmap(vm.stdout) : undefined;
	if (vmmap === undefined) {
		return fail(uiError("failed", `vmmap failed for pid ${pid}: ${vm.stderr.trim() || `exit ${vm.exitCode}`}`));
	}
	const lines = [
		`${c.app} (pid ${pid}): footprint ${mb(vmmap.footprintKb)}${vmmap.footprintPeakKb === undefined ? "" : ` (peak ${mb(vmmap.footprintPeakKb)})`}`,
		"top regions (dirty):",
		...vmmap.regions.map((r) => `  ${r.type.padEnd(16)} ${mb(r.dirtyKb)}`),
	];
	const result: Record<string, unknown> = { app: c.app, pid, vmmap };
	if (!snapshot) {
		lines.push("next: warden perf memory --snapshot · warden perf metrics --watch");
		return ok({ device: infoFor(c.target), result, text: lines.join("\n") });
	}
	const graph = join(outDir, "native", `${c.app}-${c.ctx.now()}.memgraph`);
	mkdirSync(join(outDir, "native"), { recursive: true });
	const leaksRun = await simSpawn(c, ["leaks", `--outputGraph=${graph}`, String(pid)]);
	// `leaks` exits 1 when it found leaks; anything else without a summary is a failure
	const leaks = leaksRun.exitCode <= 1 ? parseLeaks(leaksRun.stdout) : undefined;
	if (leaks === undefined) {
		return fail(
			uiError(
				"failed",
				`leaks failed for pid ${pid}: ${leaksRun.stderr.trim() || leaksRun.stdout.trim() || `exit ${leaksRun.exitCode}`}`
			)
		);
	}
	const finding = leakFinding(leaks);
	result.leaks = leaks;
	result.memgraph = graph;
	result.findings = finding ? [finding] : [];
	lines.push(
		leaks.leakCount === 0 ? "leaks: none" : `leaks: ${finding?.evidence ?? `${leaks.leakCount} leaks`}`,
		`memgraph: ${graph}`,
		`next: open ${graph} (Xcode: Debug Memory Graph)`
	);
	return ok({ device: infoFor(c.target), result, text: lines.join("\n") });
}

/**
 * `warden perf memory [--snapshot]`: where the app's memory sits right now. Plain: Android `dumpsys meminfo`
 * (TOTAL PSS/RSS, top categories) or iOS `vmmap --summary` (footprint, top regions), observe-only. `--snapshot`
 * pauses the app to capture a heap (iOS `leaks --outputGraph` memgraph + leak summary, Android `am dumpheap`
 * .hprof pulled then removed from the device), so it needs the caller's own lease.
 */
export function perfMemory(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfMemoryOptions,
	io: MemoryIo = realIo
): Promise<number> {
	const snapshot = opts.snapshot === true;
	return runPerf(ctx, deps, "memory", snapshot ? "mutate" : "observe", opts, async (target) => {
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const c: Ctx = { ctx, target, app: app.data.id };
		const out = artifactDirFor(ctx, deps.session, target.udid);
		return target.platform === "android" ? androidMemory(c, snapshot, out.dir, io) : iosMemory(c, snapshot, out.dir);
	});
}

/** Wire `memory` onto `warden perf`. */
export function registerMemory(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("memory")
			.description(
				"memory breakdown of the app; --snapshot captures a heap (iOS memgraph + leaks, Android .hprof), pausing the app"
			)
			.option("--snapshot", "capture a heap snapshot into the session dir (needs your own lease: --claim)")
	).action(async (opts) => {
		done(await perfMemory(ctx, deps, opts));
	});
}
