import { type Dirent, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { Exec } from "../exec";
import { derivedDataWorkspace } from "./derived-data";

/** An XCTestDevices tree untouched this long (and with no xcodebuild running) holds only abandoned clones. */
export const XCTEST_IDLE_MS = 60 * 60_000;

/** How many `du` runs one scan has going at once. */
const SIZE_CONCURRENCY = 4;
/** How deep the XCTestDevices mtime scan goes (clone → data → files): a running clone moves something up here. */
const MTIME_DEPTH = 3;

/** What `warden gc` sweeps: a DerivedData dir whose workspace is gone, or the XCTestDevices clone set. */
export type OrphanEntry =
	| { kind: "derived-data"; path: string; workspace: string; bytes: number }
	| { kind: "xctest-devices"; path: string; bytes: number };

export type OrphanDeps = {
	/** the user's home: only paths under it are ever scanned or removed */
	home: string;
	exec: Exec;
	now: number;
	/** default `process.platform`; anything but `darwin` has no Xcode to sweep */
	platform?: NodeJS.Platform;
	/** default `process.getuid()`: only dirs owned by this uid are touched */
	uid?: number;
};

export type RemoveOrphansResult = {
	removed: OrphanEntry[];
	skipped: { entry: OrphanEntry; reason: string }[];
};

/** `unknown`: pgrep could not answer, so nothing may be swept. */
type Procs = { kind: "ok"; lines: string[] } | { kind: "unknown" };

const derivedDataRoot = (home: string) => join(home, "Library", "Developer", "Xcode", "DerivedData");
const xctestDevicesDir = (home: string) => join(home, "Library", "Developer", "XCTestDevices");

const isDarwin = (deps: OrphanDeps) => (deps.platform ?? process.platform) === "darwin";
const uidOf = (deps: OrphanDeps) => deps.uid ?? process.getuid?.() ?? -1;

function isUnder(path: string, root: string): boolean {
	return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `path` is a real directory (never a symlink to one), under `home`, owned by this user. */
function ownDir(path: string, deps: OrphanDeps): boolean {
	if (!isUnder(path, deps.home)) return false;
	try {
		const st = lstatSync(path);
		return st.isDirectory() && st.uid === uidOf(deps);
	} catch {
		return false;
	}
}

/** `pgrep` exits 0 with matches, 1 with none; anything else (missing binary, error) cannot be trusted. */
async function runPgrep(exec: Exec, args: string[]): Promise<Procs> {
	const r = await exec(["pgrep", ...args]);
	if (r.exitCode === 1) return { kind: "ok", lines: [] };
	if (r.exitCode !== 0) return { kind: "unknown" };
	return { kind: "ok", lines: r.stdout.split("\n").filter((l) => l.trim() !== "") };
}

const xcodebuildProcs = (exec: Exec) => runPgrep(exec, ["-fl", "xcodebuild"]);
const testDeviceProcs = (exec: Exec) => runPgrep(exec, ["-f", "xcodebuild|XCTestDevices"]);

/** A volume path (`/Volumes/<x>/…`) whose volume is not mounted says nothing about the workspace. */
function volumeUnmounted(path: string): boolean {
	const m = /^(\/Volumes\/[^/]+)/.exec(path);
	return m?.[1] !== undefined && !existsSync(m[1]);
}

function workspaceGone(workspace: string): boolean {
	return !existsSync(workspace) && !volumeUnmounted(workspace);
}

/** Does a running xcodebuild command line name this DerivedData dir or its workspace? */
function xcodebuildUses(lines: string[], entry: { path: string; workspace: string }): boolean {
	return lines.some((l) => l.includes(entry.path) || l.includes(entry.workspace));
}

/** `du -sk` bytes, 0 when it cannot say: a dir that cannot be sized is still listed. */
async function sizeOf(exec: Exec, path: string): Promise<number> {
	const r = await exec(["du", "-sk", path]);
	const kb = r.exitCode === 0 ? Number.parseInt(r.stdout, 10) : Number.NaN;
	return Number.isFinite(kb) ? kb * 1024 : 0;
}

async function mapChunked<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
	return out;
}

/** The entries of `root` that are not symlinks; unreadable or missing → none. */
function listEntries(root: string): Dirent[] {
	try {
		return readdirSync(root, { withFileTypes: true }).filter((e) => !e.isSymbolicLink());
	} catch {
		return [];
	}
}

/** Newest mtime under `path`, a few levels down, without following symlinks. */
function newestMtime(path: string, depth = MTIME_DEPTH): number {
	let newest = 0;
	try {
		newest = lstatSync(path).mtimeMs;
		if (depth === 0) return newest;
		for (const e of readdirSync(path, { withFileTypes: true })) {
			if (e.isDirectory()) newest = Math.max(newest, newestMtime(join(path, e.name), depth - 1));
			else newest = Math.max(newest, lstatSync(join(path, e.name)).mtimeMs);
		}
	} catch {
		// a clone vanishing mid-scan is fine; what was read stands
	}
	return newest;
}

function isProjectDir(e: Dirent): boolean {
	return e.isDirectory() && !e.name.endsWith(".noindex") && e.name !== "ModuleCache";
}

async function findDerivedData(deps: OrphanDeps): Promise<OrphanEntry[]> {
	const root = derivedDataRoot(deps.home);
	const candidates = listEntries(root)
		.filter(isProjectDir)
		.map((e) => join(root, e.name))
		.filter((path) => ownDir(path, deps))
		.flatMap((path) => {
			const workspace = derivedDataWorkspace(path);
			return workspace !== undefined && workspaceGone(workspace) ? [{ path, workspace }] : [];
		});
	if (candidates.length === 0) return [];
	const procs = await xcodebuildProcs(deps.exec);
	if (procs.kind === "unknown") return [];
	const idle = candidates.filter((c) => !xcodebuildUses(procs.lines, c));
	return mapChunked(idle, SIZE_CONCURRENCY, async (c) => ({
		kind: "derived-data" as const,
		path: c.path,
		workspace: c.workspace,
		bytes: await sizeOf(deps.exec, c.path),
	}));
}

async function findXctestDevices(deps: OrphanDeps): Promise<OrphanEntry[]> {
	const dir = xctestDevicesDir(deps.home);
	if (!ownDir(dir, deps) || listEntries(dir).length === 0) return [];
	if (deps.now - newestMtime(dir) <= XCTEST_IDLE_MS) return [];
	const procs = await testDeviceProcs(deps.exec);
	if (procs.kind === "unknown" || procs.lines.length > 0) return [];
	return [{ kind: "xctest-devices", path: dir, bytes: await sizeOf(deps.exec, dir) }];
}

/**
 * The Xcode residue `warden gc` may delete: DerivedData dirs whose recorded workspace no longer exists
 * (volume mounted, no xcodebuild naming it) and a stale XCTestDevices clone set (no xcodebuild /
 * XCTestDevices process, untouched over an hour). Only real directories under `home` owned by this
 * user; a symlink is never followed. When running processes cannot be inspected nothing is returned.
 * Empty off macOS.
 */
export async function findOrphans(deps: OrphanDeps): Promise<OrphanEntry[]> {
	if (!isDarwin(deps)) return [];
	return [...(await findDerivedData(deps)), ...(await findXctestDevices(deps))];
}

/** Why `entry` must stay right now, or undefined when it may go. Re-checks everything the scan did. */
async function blocker(entry: OrphanEntry, deps: OrphanDeps): Promise<string | undefined> {
	if (!ownDir(entry.path, deps)) return "not a directory of yours under home";
	if (entry.kind === "xctest-devices") {
		const procs = await testDeviceProcs(deps.exec);
		if (procs.kind === "unknown") return "cannot inspect running processes";
		return procs.lines.length > 0 ? "xcodebuild or XCTestDevices process running" : undefined;
	}
	if (!workspaceGone(entry.workspace)) return "workspace exists again";
	const procs = await xcodebuildProcs(deps.exec);
	if (procs.kind === "unknown") return "cannot inspect running processes";
	return xcodebuildUses(procs.lines, entry) ? "xcodebuild is using it" : undefined;
}

/** Empty an XCTestDevices dir: `simctl --set <dir> delete all`, else remove its children (the dir stays). */
async function clearXctestDevices(dir: string, exec: Exec): Promise<void> {
	const r = await exec(["xcrun", "simctl", "--set", dir, "delete", "all"]);
	if (r.exitCode === 0) return;
	for (const e of readdirSync(dir, { withFileTypes: true }))
		rmSync(join(dir, e.name), { recursive: true, force: true });
}

async function removeEntry(entry: OrphanEntry, deps: OrphanDeps): Promise<void> {
	if (entry.kind === "xctest-devices") await clearXctestDevices(entry.path, deps.exec);
	else rmSync(entry.path, { recursive: true, force: true });
}

/**
 * Delete what `findOrphans` found, re-checking each entry first (a build may have started, a workspace
 * come back, a path been swapped for a symlink since the scan). An entry that fails a check or a
 * delete is reported in `skipped` with the reason; one failure never stops the rest.
 */
export async function removeOrphans(entries: readonly OrphanEntry[], deps: OrphanDeps): Promise<RemoveOrphansResult> {
	const result: RemoveOrphansResult = { removed: [], skipped: [] };
	if (!isDarwin(deps)) return result;
	for (const entry of entries) {
		const reason = await blocker(entry, deps);
		if (reason !== undefined) {
			result.skipped.push({ entry, reason });
			continue;
		}
		try {
			await removeEntry(entry, deps);
			result.removed.push(entry);
		} catch (e) {
			result.skipped.push({ entry, reason: `remove failed: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return result;
}
