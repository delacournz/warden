import { homedir } from "node:os";
import type { ResiduePatterns } from "../adapters/adapter.types";
import type { Platform, Residue } from "../results/schema";
import type { Exec } from "./exec";
import { type PsRow, parsePs, withDescendants } from "./sampler";

export type Snapshot = { dirKb: Record<string, number> };

/** Parses `xcrun simctl listapps` (old-style plist) into bundle ids. */
export function parseSimctlListApps(text: string): string[] {
	const ids = new Set<string>();
	for (const m of text.matchAll(/CFBundleIdentifier\s*=\s*"?([^";\s]+)"?\s*;/g)) if (m[1]) ids.add(m[1]);
	return [...ids];
}

/** Parses `adb shell pm list packages` (`package:<id>` lines). */
export function parsePmList(text: string): string[] {
	const ids: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^package:(\S+)/.exec(line.trim());
		if (m?.[1]) ids.push(m[1]);
	}
	return ids;
}

/** Exact id, or prefix match when the pattern ends with `*`. */
export function matchesBundle(id: string, pattern: string): boolean {
	return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

/** Every installed id on the device (empty when the listing fails). */
export async function listInstalled(exec: Exec, platform: Platform, udid: string): Promise<string[]> {
	if (platform === "ios") {
		const r = await exec.run("xcrun", ["simctl", "listapps", udid], { timeoutMs: 30_000 });
		return r.code === 0 ? parseSimctlListApps(r.stdout) : [];
	}
	const r = await exec.run("adb", ["-s", udid, "shell", "pm", "list", "packages"], { timeoutMs: 30_000 });
	return r.code === 0 ? parsePmList(r.stdout) : [];
}

/** Installed driver / runner apps matching the glob list. */
export async function listDriverApps(
	exec: Exec,
	platform: Platform,
	udid: string,
	bundleIds: readonly string[]
): Promise<string[]> {
	if (bundleIds.length === 0) return [];
	const installed = await listInstalled(exec, platform, udid);
	return installed.filter((id) => bundleIds.some((p) => matchesBundle(id, p)));
}

type ProcessEntry = { pid: number; line: string };

/** What counts as ours: the leased device, pids the bench spawned, and private state dirs. */
export type Owner = { udid?: string; benchPids: () => readonly number[]; ownedPaths: readonly string[] };

/**
 * Only processes this bench owns: command mentions our udid / serial or one of our private paths, or the
 * pid is one the bench spawned; plus all descendants. Other sessions' helpers never pass.
 */
export function ownerFilter(rows: readonly PsRow[], owner: Owner): PsRow[] {
	const seeds = new Set<number>(owner.benchPids());
	for (const r of rows) {
		const hitsUdid = owner.udid !== undefined && owner.udid !== "" && r.command.includes(owner.udid);
		if (hitsUdid || owner.ownedPaths.some((p) => p !== "" && r.command.includes(p))) seeds.add(r.pid);
	}
	const owned = withDescendants(rows, seeds);
	return rows.filter((r) => owned.has(r.pid));
}

/**
 * Owned processes matching any pattern as `pid command`, never including this process or its ancestors
 * (the bench's own command line can mention a framework name). Patterns only filter inside the owned set.
 */
export async function listMatchingProcesses(
	exec: Exec,
	patterns: readonly RegExp[],
	owner: Owner,
	selfPid: number = process.pid
): Promise<ProcessEntry[]> {
	if (patterns.length === 0) return [];
	const r = await exec.run("ps", ["-axo", "pid,ppid,rss,%cpu,command"], { timeoutMs: 10_000 });
	if (r.code !== 0) return [];
	const rows = parsePs(r.stdout);
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const protectedPids = new Set<number>();
	for (let pid: number | undefined = selfPid; pid !== undefined && !protectedPids.has(pid); ) {
		protectedPids.add(pid);
		pid = byPid.get(pid)?.ppid;
	}
	return ownerFilter(rows, owner)
		.filter((row) => !protectedPids.has(row.pid) && patterns.some((p) => p.test(row.command)))
		.map((row) => ({ pid: row.pid, line: `${row.pid} ${row.command}` }));
}

function expandHome(path: string, home: string): string {
	return path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
}

async function dirSizeKb(exec: Exec, dir: string): Promise<number> {
	const r = await exec.run("du", ["-sk", dir], { timeoutMs: 60_000 });
	const m = /^(\d+)/.exec(r.stdout.trim());
	return m?.[1] ? Number(m[1]) : 0;
}

export type ResidueInput = {
	exec: Exec;
	platform: Platform;
	udid: string;
	patterns: ResiduePatterns;
	owner: Owner;
	before?: Snapshot;
	home?: string;
	selfPid?: number;
};

/** Directory sizes now; call before a framework runs and pass to `checkResidue` after. */
export async function snapshotResidue(input: Omit<ResidueInput, "before" | "owner">): Promise<Snapshot> {
	const home = input.home ?? homedir();
	const dirKb: Record<string, number> = {};
	for (const dir of input.patterns.dirs) {
		const path = expandHome(dir, home);
		dirKb[path] = await dirSizeKb(input.exec, path);
	}
	return { dirKb };
}

/** What the framework left behind: matching processes, driver apps and directory growth vs `before`. */
export async function checkResidue(input: ResidueInput): Promise<Residue> {
	const now = await snapshotResidue(input);
	const processes = await listMatchingProcesses(input.exec, input.patterns.processes, input.owner, input.selfPid);
	const driverApps = await listDriverApps(input.exec, input.platform, input.udid, input.patterns.driverBundleIds);
	const paths = Object.entries(now.dirKb)
		.map(([path, kb]) => ({ path, deltaBytes: (kb - (input.before?.dirKb[path] ?? 0)) * 1024 }))
		.filter((p) => p.deltaBytes !== 0);
	return { processes: processes.map((p) => p.line), driverApps, paths };
}

export const diffResidue = checkResidue;

export type KillOptions = {
	signal?: "SIGTERM" | "SIGKILL";
	graceMs?: number;
	sleep?: (ms: number) => Promise<void>;
	selfPid?: number;
};

/**
 * Kills matching processes and returns their `pid command` lines. SIGTERM first; survivors get SIGKILL
 * after the grace period.
 */
export async function killMatching(
	exec: Exec,
	patterns: readonly RegExp[],
	owner: Owner,
	options: KillOptions = {}
): Promise<string[]> {
	const signal = options.signal ?? "SIGTERM";
	const found = await listMatchingProcesses(exec, patterns, owner, options.selfPid);
	if (found.length === 0) return [];
	const flag = signal === "SIGKILL" ? "-KILL" : "-TERM";
	await exec.run("kill", [flag, ...found.map((p) => String(p.pid))]);
	if (signal === "SIGTERM") {
		await (options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(options.graceMs ?? 3_000);
		const survivors = await listMatchingProcesses(exec, patterns, owner, options.selfPid);
		if (survivors.length > 0) await exec.run("kill", ["-KILL", ...survivors.map((p) => String(p.pid))]);
	}
	return found.map((p) => p.line);
}
