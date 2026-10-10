import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { devShim } from "../../src/commands/install";

/**
 * What `cli:link` overwrites, remembered so `cli:unlink` can put it back.
 *
 * Linking writes one entry: `~/.local/bin/warden`, the path the agent hooks call, as the shim
 * `warden install --shim` writes (`exec bun <checkout>/apps/cli/src/cli.ts`). A release binary, an
 * npm copy, a local build or another worktree's shim may already be there, so it is snapshotted
 * first, and a real file is moved aside rather than overwritten.
 *
 * The snapshot lives beside the binary rather than in the repository because what it describes is
 * machine-wide: two worktrees linking in turn share one "before", and whichever unlinks restores it.
 */

/** The entry as it was before the link. */
export type Snapshot = { kind: "absent" } | { kind: "symlink"; target: string } | { kind: "moved"; backup: string };

export type LinkPaths = { bin: string; stateFile: string; backup: string };

export type RestoreOutcome =
	| { kind: "restored"; was: Snapshot["kind"] }
	/** A real binary has taken the shim's place since; it is not ours to remove. */
	| { kind: "replaced" }
	| { kind: "not-linked" };

export function linkPaths(home: string): LinkPaths {
	const binDir = join(home, ".local", "bin");
	return {
		bin: join(binDir, "warden"),
		stateFile: join(binDir, ".warden-link.json"),
		backup: join(binDir, ".warden-link-backup"),
	};
}

const entryKind = (path: string): "absent" | "symlink" | "real" => {
	const stats = lstatSync(path, { throwIfNoEntry: false });
	if (!stats) return "absent";
	return stats.isSymbolicLink() ? "symlink" : "real";
};

const SHIM = /^#!\/bin\/sh\nexec bun "(.+)" "\$@"\n$/;

/** The `cli.ts` a source shim at `path` runs; `undefined` when `path` is anything else. */
export function shimTarget(path: string): string | undefined {
	if (entryKind(path) !== "real") return undefined;
	const head = readFileSync(path).subarray(0, 4096).toString("utf8");
	return SHIM.exec(head)?.[1];
}

function capture(paths: LinkPaths): Snapshot {
	const kind = entryKind(paths.bin);
	if (kind === "absent") return { kind };
	if (kind === "symlink") return { kind, target: readlinkSync(paths.bin) };
	renameSync(paths.bin, paths.backup);
	return { kind: "moved", backup: paths.backup };
}

/**
 * Records the entry before the shim replaces it. A snapshot already on disk is kept: the machine
 * is linked, so what is there now is a shim, not what the user had.
 */
export function snapshotLink(paths: LinkPaths): Snapshot {
	if (existsSync(paths.stateFile)) return JSON.parse(readFileSync(paths.stateFile, "utf8")) as Snapshot;
	mkdirSync(dirname(paths.bin), { recursive: true });
	const snapshot = capture(paths);
	writeFileSync(paths.stateFile, `${JSON.stringify(snapshot, null, "\t")}\n`);
	return snapshot;
}

/** Point the entry at `cliPath`. Written beside it and renamed, so a hook never runs half a file. */
export function writeShim(paths: LinkPaths, cliPath: string): void {
	mkdirSync(dirname(paths.bin), { recursive: true });
	const staged = `${paths.bin}.tmp-${process.pid}`;
	writeFileSync(staged, devShim(cliPath));
	chmodSync(staged, 0o755);
	renameSync(staged, paths.bin);
}

/**
 * Puts the entry back as the snapshot found it. With no snapshot (a checkout linked by
 * `warden install --shim`) the shim is removed only if it runs `cliPath`, so another tree's is safe.
 */
export function restoreLink(paths: LinkPaths, cliPath: string): RestoreOutcome {
	const hasState = existsSync(paths.stateFile);
	const target = shimTarget(paths.bin);

	if (!hasState && target !== cliPath) return { kind: "not-linked" };
	if (target === undefined && entryKind(paths.bin) !== "absent") {
		rmSync(paths.stateFile, { force: true });
		rmSync(paths.backup, { force: true });
		return { kind: "replaced" };
	}

	const snapshot: Snapshot = hasState
		? (JSON.parse(readFileSync(paths.stateFile, "utf8")) as Snapshot)
		: { kind: "absent" };
	rmSync(paths.bin, { force: true });
	if (snapshot.kind === "symlink") symlinkSync(snapshot.target, paths.bin);
	if (snapshot.kind === "moved") renameSync(snapshot.backup, paths.bin);
	rmSync(paths.stateFile, { force: true });
	return { kind: "restored", was: snapshot.kind };
}
