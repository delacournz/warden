import { availableParallelism, platform as osPlatform, totalmem } from "node:os";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "./exec";

export type HostOs = "darwin" | "linux" | "other";

/** What the machine can run: RAM in bytes, performance vs efficiency cores (eff is 0 where unknown). */
export type HostFacts = { totalMem: number; perfCores: number; effCores: number; os: HostOs };

export type MemoryPressure = "normal" | "warn" | "critical";

/** Plain `node:os` numbers — the fallback when `sysctl` is missing or unparsable. */
export type OsFacts = { totalMem: number; cores: number };

export const currentOs = (): HostOs => {
	const p = osPlatform();
	return p === "darwin" || p === "linux" ? p : "other";
};

const nodeOsFacts = (): OsFacts => ({ totalMem: totalmem(), cores: availableParallelism() });

const positiveInt = (line: string | undefined): number | undefined => {
	const n = Number(line?.trim());
	return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Never fails: macOS reads `hw.memsize` + `hw.perflevel{0,1}.physicalcpu` (Apple silicon performance /
 * efficiency clusters); every value it cannot read comes from `osFacts` (all cores counted as performance).
 */
export async function readHostFacts(
	exec: Exec,
	os: HostOs = currentOs(),
	osFacts: OsFacts = nodeOsFacts()
): Promise<HostFacts> {
	const fallback: HostFacts = { totalMem: osFacts.totalMem, perfCores: osFacts.cores, effCores: 0, os };
	if (os !== "darwin") return fallback;
	const result = await exec(["sysctl", "-n", "hw.memsize", "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu"]);
	const [mem, perf, eff] = result.stdout.split("\n");
	const totalMem = positiveInt(mem);
	const perfCores = positiveInt(perf);
	if (totalMem === undefined) return fallback;
	if (perfCores === undefined) return { ...fallback, totalMem };
	return { totalMem, perfCores, effCores: positiveInt(eff) ?? 0, os };
}

/** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
const MAC_LEVELS: Record<string, MemoryPressure> = { "1": "normal", "2": "warn", "4": "critical" };

/** Free-memory share below which the host is under `warn` / `critical` pressure (`memory_pressure`, /proc/meminfo). */
const WARN_FREE_PERCENT = 25;
const CRITICAL_FREE_PERCENT = 10;

const fromFreePercent = (free: number): MemoryPressure =>
	free < CRITICAL_FREE_PERCENT ? "critical" : free < WARN_FREE_PERCENT ? "warn" : "normal";

async function macFreePressure(exec: Exec): Promise<MemoryPressure | undefined> {
	const report = await exec(["memory_pressure"]);
	const free = report.stdout.match(/memory free percentage:\s*(\d+)%/i)?.[1];
	return report.exitCode === 0 && free !== undefined ? fromFreePercent(Number(free)) : undefined;
}

/**
 * The kernel level, except `warn`: macOS keeps level 2 long after compression and swap have freed memory
 * (seen at 37% free), so a kernel `warn` is confirmed against `memory_pressure`'s free share when readable.
 */
async function macPressure(exec: Exec): AsyncResult<MemoryPressure> {
	const level = await exec(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]);
	const mapped = level.exitCode === 0 ? MAC_LEVELS[level.stdout.trim()] : undefined;
	if (mapped === "warn") return ok((await macFreePressure(exec)) ?? "warn");
	if (mapped !== undefined) return ok(mapped);
	const free = await macFreePressure(exec);
	if (free !== undefined) return ok(free);
	return err("cannot read macOS memory pressure (sysctl kern.memorystatus_vm_pressure_level, memory_pressure)");
}

async function linuxPressure(exec: Exec): AsyncResult<MemoryPressure> {
	const meminfo = await exec(["cat", "/proc/meminfo"]);
	const total = Number(meminfo.stdout.match(/^MemTotal:\s*(\d+)/m)?.[1]);
	const available = Number(meminfo.stdout.match(/^MemAvailable:\s*(\d+)/m)?.[1]);
	if (meminfo.exitCode !== 0 || !(total > 0) || Number.isNaN(available))
		return err("cannot read /proc/meminfo MemAvailable");
	return ok(fromFreePercent((available / total) * 100));
}

/** Live admission signal; `Result` error = unreadable (callers treat that as `normal`, not a hold). */
export async function memoryPressure(exec: Exec, os: HostOs = currentOs()): AsyncResult<MemoryPressure> {
	if (os === "darwin") return macPressure(exec);
	if (os === "linux") return linuxPressure(exec);
	return err(`memory pressure is not readable on ${os}`);
}
