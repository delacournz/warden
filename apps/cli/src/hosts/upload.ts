import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { lookupHost, parseJsonOutput, remoteFailure, wardenArgv, wardenJson } from "./remote";
import { spawnUpload, type UploadFile } from "./setup";
import { sshArgv } from "./ssh";

/**
 * App builds sent to a host, content-addressed: `$WARDEN_HOME/uploads/<hash>/<name>` on the host, where `hash` is
 * {@link treeHash} of the build. The laptop asks first (`__host-recv --check`), so a build is sent once per host.
 */

const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._ +-]*$/;

export const isUploadHash = (s: string): boolean => HASH.test(s);
export const isUploadName = (s: string): boolean => NAME.test(s) && s !== "." && s !== "..";

/** SHA-256 over a file or a tree: each entry's relative path, kind, exec bit and content (or link target), in order. */
export async function treeHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = (abs: string, rel: string) => {
		const st = lstatSync(abs);
		if (st.isSymbolicLink()) {
			hash.update(`L ${rel} ${readlinkSync(abs)}\n`);
		} else if (st.isDirectory()) {
			hash.update(`D ${rel}\n`);
			for (const name of readdirSync(abs).sort()) walk(join(abs, name), rel === "" ? name : `${rel}/${name}`);
		} else {
			hash.update(`F ${rel} ${st.mode & 0o111 ? "x" : "-"} ${st.size}\n`);
			hash.update(readFileSync(abs));
		}
	};
	walk(path, "");
	return hash.digest("hex");
}

/** `tar` of `path` (its own name at the top) into `dir`; returns the archive path. */
export async function packTree(path: string, dir: string): Promise<string> {
	const out = join(dir, `${randomUUID()}.tar`);
	const proc = Bun.spawn(["tar", "-c", "-f", out, "-C", dirname(path), basename(path)], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`tar ${path}: ${stderr.trim()}`);
	return out;
}

const uploadPath = (home: string, hash: string, name: string) => join(home, "uploads", hash, name);

/** On the host: whether `hash` is already here, and where it is (or will be). */
export function checkUpload(home: string, hash: string, name: string): { present: boolean; path: string } {
	const path = uploadPath(home, hash, name);
	const present = existsSync(path);
	// a build asked for again is in use: its age restarts, so the prune keeps it
	if (present) touch(dirname(path));
	return { present, path };
}

/** uploads nobody asked for in this long are removed when the next one arrives */
export const UPLOAD_KEEP_MS = 7 * 86_400_000;

function touch(path: string): void {
	try {
		const now = new Date();
		utimesSync(path, now, now);
	} catch {
		// best effort: an untouched upload is only pruned sooner
	}
}

/** Remove uploads (and stale scratch dirs) not used within `keepMs`, except `keep`. Returns the hashes removed. */
export function pruneUploads(home: string, now: number, keepMs = UPLOAD_KEEP_MS, keep?: string): string[] {
	const root = join(home, "uploads");
	if (!existsSync(root)) return [];
	const removed: string[] = [];
	for (const entry of readdirSync(root)) {
		if (entry === keep) continue;
		const path = join(root, entry);
		try {
			if (now - statSync(path).mtimeMs <= keepMs) continue;
			rmSync(path, { recursive: true, force: true });
			removed.push(entry);
		} catch {
			// gone meanwhile, or not ours to read: leave it
		}
	}
	return removed;
}

/**
 * On the host: unpack the tar on `input` into a scratch dir, check its tree hash, then move it to
 * `uploads/<hash>/` in one rename. A mismatch (a truncated or altered stream) leaves nothing behind.
 */
export async function receiveUpload(
	home: string,
	target: { hash: string; name: string },
	input: ReadableStream<Uint8Array>
): Promise<Result<string>> {
	const { hash, name } = target;
	if (!isUploadHash(hash) || !isUploadName(name)) return err(`bad upload ${hash}/${name}`);
	const final = uploadPath(home, hash, name);
	const scratch = join(home, "uploads", `.recv-${randomUUID()}`);
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	try {
		const proc = Bun.spawn(["tar", "-x", "-f", "-", "-C", scratch], { stdin: input, stdout: "ignore", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) return err(`tar: ${stderr.trim() || `exited ${code}`}`);
		const got = join(scratch, name);
		if (!existsSync(got)) return err(`the upload holds no ${name}`);
		const actual = await treeHash(got);
		if (actual !== hash)
			return err(`the upload's content (${actual.slice(0, 12)}) does not match ${hash.slice(0, 12)}`);
		if (existsSync(final)) return ok(final);
		mkdirSync(dirname(final), { recursive: true });
		renameSync(got, final);
		pruneUploads(home, Date.now(), UPLOAD_KEEP_MS, hash);
		return ok(final);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export type UploadDeps = { upload?: UploadFile };

function stringField(json: unknown, key: string): string | undefined {
	const v: unknown = typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;
	return typeof v === "string" ? v : undefined;
}

/** Send the build at `path` to `hostName` unless it has it already; the path of the copy on the host. */
export async function uploadToHost(
	ctx: CommandContext,
	hostName: string,
	path: string,
	deps: UploadDeps = {}
): Promise<Result<string>> {
	const host = lookupHost(ctx, hostName);
	if (!host.success) return host;
	const hash = await treeHash(path);
	const name = basename(path);
	if (!isUploadName(name)) return err(`${name}: not a name a host takes (letters, digits, . _ + - and spaces)`);
	const args = ["__host-recv", "--hash", hash, "--name", name, "--json"];
	const checked = await wardenJson(ctx, host.data, [...args.slice(0, -1), "--check", "--json"]);
	if (!checked.success) return checked;
	const present: unknown =
		typeof checked.data.json === "object" && checked.data.json !== null
			? Reflect.get(checked.data.json, "present")
			: false;
	const there = stringField(checked.data.json, "path");
	if (present === true && there !== undefined) return ok(there);
	const scratch = join(wardenHome(ctx.env), "uploads-out");
	mkdirSync(scratch, { recursive: true });
	const tar = await packTree(path, scratch);
	try {
		const argv = sshArgv(host.data, wardenArgv(host.data, args), { home: wardenHome(ctx.env) });
		const sent = await (deps.upload ?? spawnUpload)(argv, tar);
		const json = parseJsonOutput(sent.stdout);
		const at = stringField(json, "path");
		if (sent.exitCode === 0 && at !== undefined) return ok(at);
		const why = remoteFailure(json)?.message ?? (sent.stderr.trim() || `exited ${sent.exitCode}`);
		return err(`${hostName}: upload of ${name} failed: ${why}`);
	} finally {
		rmSync(tar, { force: true });
	}
}
