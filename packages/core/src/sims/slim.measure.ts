import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Exec } from "../exec";

/** One process row from `ps -axo pid,ppid,comm`. */
export type PsRow = { pid: number; ppid: number; command: string };
export type PsSnapshot = Map<number, PsRow>;

export type ProcessMem = { pid: number; command: string; bytes: number };

export type TreeMeasurement = {
	processes: number;
	footprintBytes: number;
	/** every process in the tree, biggest first */
	top: ProcessMem[];
};

export type SimMeasurement = TreeMeasurement & { udid: string };

const UNIT_BYTES: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** `168M`, `1024K+`, `1.2G-`, `12B` → bytes; undefined for anything else. */
export function parseMemUnit(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([BKMG])[+-]?$/.exec(text.trim());
	if (!match) return undefined;
	return Math.round(Number(match[1]) * (UNIT_BYTES[match[2] as string] as number));
}

/** `ps -axo pid,ppid,comm` output; comm is a full path, so keep its basename. */
export function parsePs(stdout: string): PsSnapshot {
	const rows: PsSnapshot = new Map();
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		rows.set(pid, { pid, ppid: Number(match[2]), command: (match[3] as string).split("/").pop() ?? "" });
	}
	return rows;
}

/** `top -l 1 -stats pid,mem` output → pid → phys_footprint bytes. */
export function parseTopMem(stdout: string): Map<number, number> {
	const mem = new Map<number, number>();
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match) continue;
		const bytes = parseMemUnit(match[2] as string);
		if (bytes !== undefined) mem.set(Number(match[1]), bytes);
	}
	return mem;
}

/** `root` plus every transitive child in the snapshot. */
export function treePids(root: number, snap: PsSnapshot): number[] {
	const children = new Map<number, number[]>();
	for (const row of snap.values()) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
	const seen = new Set<number>([root]);
	const queue = [root];
	for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			queue.push(child);
		}
	}
	return [...seen];
}

export function measureTree(root: number, snap: PsSnapshot, mem: Map<number, number>): TreeMeasurement {
	const top = treePids(root, snap)
		.map((pid): ProcessMem => ({ pid, command: snap.get(pid)?.command ?? "?", bytes: mem.get(pid) ?? 0 }))
		.sort((a, b) => b.bytes - a.bytes || a.pid - b.pid);
	return { processes: top.length, footprintBytes: top.reduce((sum, p) => sum + p.bytes, 0), top };
}

/** Root of a booted sim's process tree: its `launchd_sim`, found by the bootstrap socket path under the udid. */
async function rootPid(exec: Exec, udid: string): Promise<number | undefined> {
	const res = await exec(["pgrep", "-f", `${udid}/data/var/run/launchd_bootstrap`]);
	if (res.exitCode !== 0) return undefined;
	const pid = Number(res.stdout.trim().split("\n")[0]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function snapshots(exec: Exec): AsyncResult<{ snap: PsSnapshot; mem: Map<number, number> }> {
	const [ps, top] = await Promise.all([
		exec(["ps", "-axo", "pid,ppid,comm"]),
		exec(["top", "-l", "1", "-stats", "pid,mem"]),
	]);
	if (ps.exitCode !== 0) return err(`ps exited ${ps.exitCode}: ${ps.stderr.trim()}`);
	if (top.exitCode !== 0) return err(`top exited ${top.exitCode}: ${top.stderr.trim()}`);
	return ok({ snap: parsePs(ps.stdout), mem: parseTopMem(top.stdout) });
}

/** Real memory cost of the simulators: summed phys_footprint (what Activity Monitor shows) under each `launchd_sim`. */
export async function measureSims(exec: Exec, udids: readonly string[]): Promise<Map<string, Result<SimMeasurement>>> {
	const out = new Map<string, Result<SimMeasurement>>();
	const roots = new Map<string, number>();
	await Promise.all(
		udids.map(async (udid) => {
			const pid = await rootPid(exec, udid);
			if (pid === undefined) out.set(udid, err(`${udid}: not booted`));
			else roots.set(udid, pid);
		})
	);
	if (roots.size > 0) {
		const snaps = await snapshots(exec);
		for (const [udid, pid] of roots) {
			out.set(udid, snaps.success ? ok({ udid, ...measureTree(pid, snaps.data.snap, snaps.data.mem) }) : snaps);
		}
	}
	return new Map(udids.flatMap((u) => (out.has(u) ? [[u, out.get(u) as Result<SimMeasurement>] as const] : [])));
}

export async function measureSim(exec: Exec, udid: string): AsyncResult<SimMeasurement> {
	return (await measureSims(exec, [udid])).get(udid) ?? err(`${udid}: not booted`);
}
