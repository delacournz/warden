import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { wardenHome } from "./home";

/** The file system calls and the caller's uid, injected so tests can stand in another owner. */
export type PrivateFs = {
	mkdirSync: (path: string, options: { recursive: true; mode: number }) => unknown;
	statSync: (path: string) => { uid: number; mode: number; isDirectory(): boolean };
	lstatSync: (path: string) => { isSymbolicLink(): boolean };
	chmodSync: (path: string, mode: number) => unknown;
	uid: () => number | undefined;
};

export const nodePrivateFs: PrivateFs = {
	mkdirSync,
	statSync,
	lstatSync,
	chmodSync,
	uid: () => process.getuid?.(),
};

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const GROUP_OR_OTHER = 0o077;

/**
 * `path` as a directory only its owner can enter: created `0700` (parents too) when missing, tightened to `0700` when
 * it exists and group or others can reach it. A directory another user owns is an error and is left as it is.
 * `noFollow` also refuses a symbolic link (a directory under a shared temp dir); a home may be a link to another disk.
 */
export function ensurePrivateDir(
	path: string,
	options: { noFollow?: boolean } = {},
	fs: PrivateFs = nodePrivateFs
): Result<string> {
	try {
		fs.mkdirSync(path, { recursive: true, mode: OWNER_ONLY_DIR });
		if (options.noFollow === true && fs.lstatSync(path).isSymbolicLink())
			return err(`${path} is a symbolic link: warden keeps its sockets in a directory of its own`);
		const stat = fs.statSync(path);
		if (!stat.isDirectory()) return err(`${path} is not a directory`);
		const uid = fs.uid();
		if (uid !== undefined && stat.uid !== uid)
			return err(
				`${path} is owned by uid ${stat.uid}, not by you (uid ${uid}): warden keeps its state owner-only. Remove it, or point WARDEN_HOME at a directory you own`
			);
		if ((stat.mode & GROUP_OR_OTHER) !== 0) fs.chmodSync(path, OWNER_ONLY_DIR);
		return ok(path);
	} catch (error) {
		return err(`cannot make ${path} owner-only: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * A short per-user directory for the sockets whose preferred path is too long for `sun_path` (~104 bytes):
 * `/tmp/warden-<uid>` (macOS's own temp dir is too deep to help). Pure: `ensureSocketDir` creates and checks it.
 */
export function privateTmpDir(
	host: { platform: string; uid: () => number | undefined; tmpdir: () => string } = {
		platform: process.platform,
		uid: nodePrivateFs.uid,
		tmpdir,
	}
): string {
	return join(host.platform === "darwin" ? "/tmp" : host.tmpdir(), `warden-${host.uid() ?? "user"}`);
}

/** Where a socket's directory is judged: the warden home (from `env`) and the per-user temp directory. */
export type SocketScope = {
	env?: Record<string, string | undefined>;
	tmp?: () => string;
	fs?: PrivateFs;
};

function isWithin(dir: string, root: string): boolean {
	const [inner, outer] = [resolve(dir), resolve(root)];
	return inner === outer || inner.startsWith(`${outer}${sep}`);
}

/**
 * The directory a unix socket is bound in. One of warden's own (under the warden home, or the per-user temp
 * directory) must be the caller's, owner-only and no symbolic link: it is created or tightened, else an error.
 * A socket path given by hand anywhere else only has its directory created when missing: a directory warden does
 * not own is never changed, and the `0600` socket is the limit there.
 */
export function ensureSocketDir(socketPath: string, scope: SocketScope = {}): Result<string> {
	const dir = dirname(socketPath);
	const fs = scope.fs ?? nodePrivateFs;
	if (isWithin(dir, wardenHome(scope.env)) || resolve(dir) === resolve((scope.tmp ?? privateTmpDir)()))
		return ensurePrivateDir(dir, { noFollow: true }, fs);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
		return ok(dir);
	} catch (error) {
		return err(`cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Before connecting to a socket in the per-user temp directory (a shared parent, so anyone can make a directory of
 * that name): the directory must be the caller's own and no symbolic link. Nothing is created or changed. A missing
 * directory passes (the connect fails by itself), and so does a socket anywhere else.
 */
export function verifySocketDir(socketPath: string, scope: Pick<SocketScope, "tmp" | "fs"> = {}): Result<string> {
	const dir = dirname(socketPath);
	const fs = scope.fs ?? nodePrivateFs;
	if (resolve(dir) !== resolve((scope.tmp ?? privateTmpDir)())) return ok(dir);
	try {
		if (fs.lstatSync(dir).isSymbolicLink())
			return err(`${dir} is a symbolic link: warden keeps its sockets in a directory of its own`);
		const stat = fs.statSync(dir);
		const uid = fs.uid();
		if (!stat.isDirectory()) return err(`${dir} is not a directory`);
		if (uid !== undefined && stat.uid !== uid)
			return err(`${dir} is owned by uid ${stat.uid}, not by you (uid ${uid}): not connecting to a socket in it`);
		return ok(dir);
	} catch {
		return ok(dir);
	}
}

/** `0600` on a file that exists (a database, its `-wal` / `-shm`); a missing one is skipped. */
export function restrictFile(path: string): void {
	try {
		if ((statSync(path).mode & GROUP_OR_OTHER) !== 0) chmodSync(path, OWNER_ONLY_FILE);
	} catch {
		// not there (yet), or not ours to change
	}
}

/**
 * Run a synchronous `bind` (`Bun.listen({ unix })`, `server.listen(path)`) with a umask that creates the socket
 * `0600`, so it is never reachable by group or others, then put the umask back. Follow with `restrictSocket`.
 */
export function listenOwnerOnly<T>(listen: () => T): T {
	let previous: number | undefined;
	try {
		previous = process.umask(0o177);
	} catch {
		// a worker thread cannot set the umask: `restrictSocket` and the owner-only directory still apply
	}
	try {
		return listen();
	} finally {
		if (previous !== undefined) process.umask(previous);
	}
}

/** `0600` on a bound unix socket. */
export function restrictSocket(socketPath: string): void {
	try {
		chmodSync(socketPath, OWNER_ONLY_FILE);
	} catch {
		// already closed and unlinked
	}
}
