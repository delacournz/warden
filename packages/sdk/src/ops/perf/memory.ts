import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { iosMemoryParser, type LeaksSummary, type VmmapSummary } from "@delacour/warden-perf/metrics/ios-memory";
import { type Meminfo, meminfoParser } from "@delacour/warden-perf/metrics/meminfo";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import { appProcess } from "./app-process";
import type { PerfEnv } from "./env";
import type { PerfDone, PerfOutcome, PerfTarget } from "./types";

/** Waits `ms`; tests inject one that does not. */
export type MemoryIo = { sleep: (ms: number) => Promise<void> };

export const realMemoryIo: MemoryIo = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

const KB_PER_MB = 1024;
/** How long `am dumpheap` may take to finish writing the file, and how often it is looked at. */
const DUMP_WAIT_MS = 60_000;
const DUMP_POLL_MS = 500;
const SNAPSHOT_TIMEOUT_MS = 120_000;

type Ctx = { ctx: PerfEnv; target: PerfTarget; app: string };

/** `am dumpheap` refuses apps that are neither debuggable nor profileable. */
const NOT_DEBUGGABLE = /not debuggable|SecurityException|not profileable/i;

/** The `result` of `perf memory --json`: the platform's breakdown, and with a snapshot where it was written. */
export type MemoryResult = {
	app: string;
	pid?: number;
	meminfo?: Meminfo;
	vmmap?: VmmapSummary;
	hprof?: { path: string; bytes: number };
	leaks?: LeaksSummary;
	memgraph?: string;
	findings?: Finding[];
};

/** PerfMemory: memory. */
export class PerfMemory {
	private readonly mb = (kb: number): string => `${(kb / KB_PER_MB).toFixed(1)} MB`;

	private readonly fail = (error: WardenError): { success: false; error: WardenError } => ({ success: false, error });

	private readonly notRunning = (target: PerfTarget, app: string): WardenError =>
		opErrors.opError("app_not_found", `${app} is not running on ${target.udid}`, {
			hint: "launch the app first (warden ui open <app>)",
		});

	private categoriesText(info: Meminfo): string[] {
		return info.categories.map((c) => `  ${c.name.padEnd(14)} ${this.mb(c.pssKb)}`);
	}

	private infoFor(target: PerfTarget): PerfDone["device"] {
		return {
			udid: target.udid,
			platform: target.platform,
			...(target.name !== undefined ? { name: target.name } : {}),
		};
	}

	// ---------------------------------------------------------------------------------------------- Android
	private async androidMeminfo({ ctx, target, app }: Ctx): Promise<Result<Meminfo, WardenError>> {
		const res = await ctx.exec(
			[androidToolsLocator.locate(ctx.env).adb, "-s", target.udid, "shell", "dumpsys", "meminfo", app],
			{
				timeoutMs: 15_000,
			}
		);
		const info = res.exitCode === 0 ? meminfoParser.parseMeminfo(res.stdout) : undefined;
		return info === undefined ? this.fail(this.notRunning(target, app)) : resultFactory.ok(info);
	}

	private async dumpHeap(
		{ ctx, target, app }: Ctx,
		outDir: string,
		io: MemoryIo
	): Promise<Result<{ path: string; bytes: number }, WardenError>> {
		const adb = androidToolsLocator.locate(ctx.env).adb;
		const shell = (...args: string[]) => ctx.exec([adb, "-s", target.udid, "shell", ...args], { timeoutMs: 15_000 });
		const remote = `/data/local/tmp/warden-${app}-${ctx.now()}.hprof`;
		const local = join(outDir, "native", `${app}-${ctx.now()}.hprof`);
		try {
			await shell("touch", remote);
			await shell("chmod", "666", remote);
			const dump = await shell("am", "dumpheap", app, remote);
			const said = `${dump.stdout}\n${dump.stderr}`;
			if (NOT_DEBUGGABLE.test(said)) {
				return this.fail(
					opErrors.opError(
						"not_profileable",
						`${app} is not debuggable or profileable, so Android refuses a heap dump`,
						{
							hint: 'debug build, or <profileable android:shell="true"/> in the manifest (warden perf doctor)',
						}
					)
				);
			}
			if (dump.exitCode !== 0) {
				return this.fail(opErrors.opError("failed", `am dumpheap failed: ${said.trim() || `exit ${dump.exitCode}`}`));
			}
			const bytes = await this.waitForDump(shell, remote, io);
			if (bytes === undefined) {
				return this.fail(
					opErrors.opError("failed", `the heap dump did not finish within ${DUMP_WAIT_MS / 1000}s`, {
						hint: "retry; a large heap takes longer",
					})
				);
			}
			mkdirSync(join(outDir, "native"), { recursive: true });
			const pulled = await ctx.exec([adb, "-s", target.udid, "pull", remote, local], {
				timeoutMs: SNAPSHOT_TIMEOUT_MS,
			});
			if (pulled.exitCode !== 0)
				return this.fail(
					opErrors.opError("failed", `adb pull failed: ${pulled.stderr.trim() || `exit ${pulled.exitCode}`}`)
				);
			return resultFactory.ok({ path: local, bytes });
		} finally {
			await shell("rm", "-f", remote);
		}
	}

	/** The dump's size once it stops growing (two equal non-zero readings), else undefined after `DUMP_WAIT_MS`. */
	private async waitForDump(
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

	private async androidMemory(c: Ctx, snapshot: boolean, outDir: string, io: MemoryIo): PerfOutcome<MemoryResult> {
		const info = await this.androidMeminfo(c);
		if (!info.success) return info;
		const lines = [
			`${c.app} (pid ${info.data.pid ?? "?"}): PSS ${this.mb(info.data.totalPssKb)}${info.data.totalRssKb === undefined ? "" : `, RSS ${this.mb(info.data.totalRssKb)}`}`,
			"top categories (PSS):",
			...this.categoriesText(info.data),
		];
		const result: MemoryResult = { app: c.app, meminfo: info.data };
		if (!snapshot) {
			lines.push("next: warden perf memory --snapshot · warden perf metrics --watch");
			return resultFactory.ok({ device: this.infoFor(c.target), result, text: lines.join("\n") });
		}
		const heap = await this.dumpHeap(c, outDir, io);
		if (!heap.success) return heap;
		result.hprof = heap.data;
		lines.push(
			`heap dump: ${heap.data.path} (${this.mb(heap.data.bytes / 1024)})`,
			"raw .hprof only: open it in Android Studio (Profiler > Load) or convert with hprof-conv for other tools",
			"next: warden perf heap snapshot (Hermes JS heap)"
		);
		return resultFactory.ok({ device: this.infoFor(c.target), result, text: lines.join("\n") });
	}

	// ---------------------------------------------------------------------------------------------- iOS
	private async simSpawn(c: Ctx, args: string[]) {
		return c.ctx.exec(["xcrun", "simctl", "spawn", c.target.udid, ...args], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
	}

	private leakFinding(leaks: LeaksSummary): Finding | undefined {
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

	private async iosMemory(c: Ctx, snapshot: boolean, outDir: string): PerfOutcome<MemoryResult> {
		const pid = await appProcess.appPid(c.ctx, { platform: "ios", id: c.target.udid }, c.app);
		if (pid === undefined) return this.fail(this.notRunning(c.target, c.app));
		const vm = await this.simSpawn(c, ["vmmap", "--summary", String(pid)]);
		const vmmap: VmmapSummary | undefined = vm.exitCode === 0 ? iosMemoryParser.parseVmmap(vm.stdout) : undefined;
		if (vmmap === undefined) {
			if (/cannot examine process/i.test(vm.stderr)) {
				return this.fail(
					opErrors.opError("not_profileable", `the OS won't let vmmap read ${c.app} (pid ${pid})`, {
						hint: "Apple-signed and release apps can't be inspected; use a debug build (get-task-allow)",
					})
				);
			}
			return this.fail(
				opErrors.opError("failed", `vmmap failed for pid ${pid}: ${vm.stderr.trim() || `exit ${vm.exitCode}`}`)
			);
		}
		const lines = [
			`${c.app} (pid ${pid}): footprint ${this.mb(vmmap.footprintKb)}${vmmap.footprintPeakKb === undefined ? "" : ` (peak ${this.mb(vmmap.footprintPeakKb)})`}`,
			"top regions (dirty):",
			...vmmap.regions.map((r) => `  ${r.type.padEnd(16)} ${this.mb(r.dirtyKb)}`),
		];
		const result: MemoryResult = { app: c.app, pid, vmmap };
		if (!snapshot) {
			lines.push("next: warden perf memory --snapshot · warden perf metrics --watch");
			return resultFactory.ok({ device: this.infoFor(c.target), result, text: lines.join("\n") });
		}
		const graph = join(outDir, "native", `${c.app}-${c.ctx.now()}.memgraph`);
		mkdirSync(join(outDir, "native"), { recursive: true });
		const leaksRun = await this.simSpawn(c, ["leaks", `--outputGraph=${graph}`, String(pid)]);
		// `leaks` exits 1 when it found leaks; anything else without a summary is a failure
		const leaks = leaksRun.exitCode <= 1 ? iosMemoryParser.parseLeaks(leaksRun.stdout) : undefined;
		if (leaks === undefined) {
			return this.fail(
				opErrors.opError(
					"failed",
					`leaks failed for pid ${pid}: ${leaksRun.stderr.trim() || leaksRun.stdout.trim() || `exit ${leaksRun.exitCode}`}`
				)
			);
		}
		const finding = this.leakFinding(leaks);
		result.leaks = leaks;
		result.memgraph = graph;
		result.findings = finding ? [finding] : [];
		lines.push(
			leaks.leakCount === 0 ? "leaks: none" : `leaks: ${finding?.evidence ?? `${leaks.leakCount} leaks`}`,
			`memgraph: ${graph}`,
			`next: open ${graph} (Xcode: Debug Memory Graph)`
		);
		return resultFactory.ok({ device: this.infoFor(c.target), result, text: lines.join("\n") });
	}

	/**
	 * Where the app's memory sits now (Android `dumpsys meminfo`, iOS `vmmap --summary`); with `snapshot` also a heap
	 * (iOS memgraph + leaks summary, Android `.hprof`) written under `outDir`. `snapshot` pauses the app, so the caller
	 * holds the device lease.
	 */
	memoryWork(
		ctx: PerfEnv,
		target: PerfTarget,
		app: string,
		snapshot: boolean,
		outDir: string,
		io: MemoryIo = realMemoryIo
	): PerfOutcome<MemoryResult> {
		const c: Ctx = { ctx, target, app };
		return target.platform === "android"
			? this.androidMemory(c, snapshot, outDir, io)
			: this.iosMemory(c, snapshot, outDir);
	}
}

export const perfMemoryOps = new PerfMemory();
