import { DISK_DEFAULTS } from "./disk.defaults";
import type { Exec, ExecResult } from "./exec";
import type { HostOs } from "./host";

const GB = 1024 ** 3;
const KB = 1024;
const DAY_MS = 86_400_000;

/**
 * What fills a disk on an agent machine besides files: free space, swap (on the boot disk), APFS local snapshots
 * (a staged macOS update pins every block deleted since) and uptime (swap only fully clears on reboot).
 * Every field is optional: a probe that fails or can't be parsed is left out, never thrown.
 */
export type DiskFacts = {
	freeBytes?: number;
	totalBytes?: number;
	swapUsedBytes?: number;
	/** macOS only: `tmutil listlocalsnapshots /` split by origin */
	snapshots?: { osUpdate: number; timeMachine: number };
	uptimeDays?: number;
};

/** Overrides from `~/.warden` config / env; every field is optional. */
export type DiskConfig = { floorGb?: number; criticalGb?: number; swapWarnGb?: number };

export type DiskThresholds = { floorBytes: number; criticalBytes: number; swapWarnBytes: number };

export type DiskLevel = "ok" | "warn" | "critical";

export type DiskReason =
	| { kind: "swap"; swapUsedBytes: number; warnBytes: number }
	| { kind: "os-update-snapshots"; count: number }
	| { kind: "tm-snapshots"; count: number }
	| { kind: "low-free"; freeBytes: number; floorBytes: number; criticalBytes: number }
	| { kind: "uptime"; days: number };

export type DiskVerdict = { level: DiskLevel; reasons: DiskReason[] };

/** `df -Pk` data row: total and available 1K-blocks. */
export function parseDf(stdout: string): { freeBytes: number; totalBytes: number } | undefined {
	const row = stdout.trim().split("\n")[1]?.trim().split(/\s+/);
	const total = Number(row?.[1]);
	const free = Number(row?.[3]);
	if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return undefined;
	return { freeBytes: free * KB, totalBytes: total * KB };
}

const UNIT: Record<string, number> = { K: KB, M: KB ** 2, G: GB, T: GB * KB };

/** macOS `sysctl -n vm.swapusage`: `total = 20.00G  used = 17.50G  free = 2.50G  (encrypted)`. */
export function parseMacSwap(stdout: string): number | undefined {
	const m = stdout.match(/used\s*=\s*([\d.]+)([KMGT])/);
	if (!m?.[1] || !m[2]) return undefined;
	return Math.round(Number(m[1]) * (UNIT[m[2]] ?? 1));
}

/** `/proc/meminfo`: SwapTotal - SwapFree (kB). */
export function parseLinuxSwap(meminfo: string): number | undefined {
	const total = meminfo.match(/^SwapTotal:\s*(\d+)/m)?.[1];
	const free = meminfo.match(/^SwapFree:\s*(\d+)/m)?.[1];
	if (total === undefined || free === undefined) return undefined;
	return (Number(total) - Number(free)) * KB;
}

/** `tmutil listlocalsnapshots /`: `com.apple.os.update-*` (staged OS update) vs `com.apple.TimeMachine.*`. */
export function parseSnapshots(stdout: string): { osUpdate: number; timeMachine: number } {
	const lines = stdout.split("\n").map((l) => l.trim());
	return {
		osUpdate: lines.filter((l) => l.startsWith("com.apple.os.update-")).length,
		timeMachine: lines.filter((l) => l.startsWith("com.apple.TimeMachine.")).length,
	};
}

/** macOS `sysctl -n kern.boottime`: `{ sec = 1761600000, usec = 0 } ...` → boot time in ms. */
export function parseBoottime(stdout: string): number | undefined {
	const sec = stdout.match(/sec\s*=\s*(\d+)/)?.[1];
	return sec === undefined ? undefined : Number(sec) * 1000;
}

/** `/proc/uptime`: first field is seconds since boot → ms. */
export function parseLinuxUptime(stdout: string): number | undefined {
	const secs = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? "");
	return Number.isFinite(secs) ? secs * 1000 : undefined;
}

/** Run one probe; a throw or non-zero exit reads as no output. */
async function probe(exec: Exec, cmd: readonly string[]): Promise<string | undefined> {
	let result: ExecResult;
	try {
		result = await exec(cmd, { timeoutMs: 5_000 });
	} catch {
		return undefined;
	}
	return result.exitCode === 0 ? result.stdout : undefined;
}

const days = (ms: number): number => Math.floor(ms / DAY_MS);

export type DiskProbeOpts = { os: HostOs; home: string; now: number };

/** One OS's probes: each reads one command's stdout into the facts it can give. */
type Probe = { cmd: readonly string[]; read: (stdout: string, now: number) => DiskFacts };

const uptimeFacts = (upMs: number | undefined): DiskFacts =>
	upMs === undefined || upMs < 0 ? {} : { uptimeDays: days(upMs) };

const swapFacts = (bytes: number | undefined): DiskFacts => (bytes === undefined ? {} : { swapUsedBytes: bytes });

const OS_PROBES: Record<HostOs, readonly Probe[]> = {
	darwin: [
		{ cmd: ["sysctl", "-n", "vm.swapusage"], read: (out) => swapFacts(parseMacSwap(out)) },
		{ cmd: ["tmutil", "listlocalsnapshots", "/"], read: (out) => ({ snapshots: parseSnapshots(out) }) },
		{
			cmd: ["sysctl", "-n", "kern.boottime"],
			read: (out, now) => uptimeFacts(mapDefined(parseBoottime(out), (boot) => now - boot)),
		},
	],
	linux: [
		{ cmd: ["cat", "/proc/meminfo"], read: (out) => swapFacts(parseLinuxSwap(out)) },
		{ cmd: ["cat", "/proc/uptime"], read: (out) => uptimeFacts(parseLinuxUptime(out)) },
	],
	other: [],
};

/** Read the disk facts of the volume holding `home`. Probes run in parallel; each one that fails is left out. */
export async function readDiskFacts(exec: Exec, opts: DiskProbeOpts): Promise<DiskFacts> {
	const probes: Probe[] = [{ cmd: ["df", "-Pk", opts.home], read: (out) => parseDf(out) ?? {} }, ...OS_PROBES[opts.os]];
	const parts = await Promise.all(
		probes.map(async (p) => mapDefined(await probe(exec, p.cmd), (out) => p.read(out, opts.now)) ?? {})
	);
	return Object.assign({}, ...parts);
}

const mapDefined = <A, B>(a: A | undefined, f: (a: A) => B): B | undefined => (a === undefined ? undefined : f(a));

/** Floor `max(20 GB, 10%)`, critical `max(8 GB, 4%)` of the volume, swap warn 8 GB; config wins, critical ≤ floor. */
export function diskThresholds(totalBytes: number | undefined, cfg: DiskConfig): DiskThresholds {
	const total = totalBytes ?? 0;
	const floorBytes =
		cfg.floorGb !== undefined
			? cfg.floorGb * GB
			: Math.max(DISK_DEFAULTS.floorGb * GB, total * DISK_DEFAULTS.floorShare);
	const critical =
		cfg.criticalGb !== undefined
			? cfg.criticalGb * GB
			: Math.max(DISK_DEFAULTS.criticalGb * GB, total * DISK_DEFAULTS.criticalShare);
	return {
		floorBytes,
		criticalBytes: Math.min(critical, floorBytes),
		swapWarnBytes: (cfg.swapWarnGb ?? DISK_DEFAULTS.swapWarnGb) * GB,
	};
}

/**
 * The host's disk verdict. Memory reasons (swap, snapshots) come first: deleting files won't stop swap refilling
 * the disk. Only free space below the critical threshold is `critical`; everything else warns.
 */
export function judgeDisk(facts: DiskFacts, cfg: DiskConfig): DiskVerdict {
	const t = diskThresholds(facts.totalBytes, cfg);
	const reasons = [...memoryReasons(facts, t), ...spaceReasons(facts, t)];
	const critical = facts.freeBytes !== undefined && facts.freeBytes < t.criticalBytes;
	return { level: critical ? "critical" : reasons.length > 0 ? "warn" : "ok", reasons };
}

/** Swap and local snapshots: space no file cleanup gives back. */
function memoryReasons(facts: DiskFacts, t: DiskThresholds): DiskReason[] {
	const reasons: DiskReason[] = [];
	if (facts.swapUsedBytes !== undefined && facts.swapUsedBytes > t.swapWarnBytes)
		reasons.push({ kind: "swap", swapUsedBytes: facts.swapUsedBytes, warnBytes: t.swapWarnBytes });
	const snaps = facts.snapshots ?? { osUpdate: 0, timeMachine: 0 };
	if (snaps.osUpdate > 0) reasons.push({ kind: "os-update-snapshots", count: snaps.osUpdate });
	if (snaps.timeMachine > 0) reasons.push({ kind: "tm-snapshots", count: snaps.timeMachine });
	return reasons;
}

function spaceReasons(facts: DiskFacts, t: DiskThresholds): DiskReason[] {
	const reasons: DiskReason[] = [];
	if (facts.freeBytes !== undefined && facts.freeBytes < t.floorBytes)
		reasons.push({
			kind: "low-free",
			freeBytes: facts.freeBytes,
			floorBytes: t.floorBytes,
			criticalBytes: t.criticalBytes,
		});
	if (facts.uptimeDays !== undefined && facts.uptimeDays >= DISK_DEFAULTS.uptimeWarnDays)
		reasons.push({ kind: "uptime", days: facts.uptimeDays });
	return reasons;
}
