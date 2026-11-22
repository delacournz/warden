import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensurePrivateDir,
	ensureSocketDir,
	listenOwnerOnly,
	nodePrivateFs,
	type PrivateFs,
	privateTmpDir,
	restrictFile,
	restrictSocket,
} from "./private-fs";

let dir: string;
const mode = (path: string): number => statSync(path).mode & 0o777;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-private-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("ensurePrivateDir", () => {
	test("creates a missing directory (and its parents) owner-only", () => {
		const home = join(dir, "a", "home");
		expect(ensurePrivateDir(home)).toEqual({ success: true, data: home });
		expect(mode(home)).toBe(0o700);
	});

	test("an existing directory open to group or others becomes owner-only", () => {
		const home = join(dir, "home");
		mkdirSync(home);
		chmodSync(home, 0o755);
		expect(ensurePrivateDir(home).success).toBe(true);
		expect(mode(home)).toBe(0o700);
	});

	test("an owner-only directory is left alone", () => {
		const home = join(dir, "home");
		mkdirSync(home, { mode: 0o700 });
		const chmods: string[] = [];
		const fs: PrivateFs = { ...nodePrivateFs, chmodSync: (path) => chmods.push(path) };
		expect(ensurePrivateDir(home, {}, fs).success).toBe(true);
		expect(chmods).toEqual([]);
	});

	test("a directory owned by another user is an error, and is not changed", () => {
		const home = join(dir, "home");
		mkdirSync(home);
		chmodSync(home, 0o755);
		const fs: PrivateFs = { ...nodePrivateFs, uid: () => statSync(home).uid + 1 };
		const result = ensurePrivateDir(home, {}, fs);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain(`${home} is owned by uid ${statSync(home).uid}`);
		expect(mode(home)).toBe(0o755);
	});

	test("a symlink is followed for a home, refused with noFollow", () => {
		const target = join(dir, "target");
		const link = join(dir, "link");
		mkdirSync(target);
		chmodSync(target, 0o755);
		symlinkSync(target, link);
		const refused = ensurePrivateDir(link, { noFollow: true });
		expect(refused.success).toBe(false);
		if (!refused.success) expect(refused.error).toContain("symbolic link");
		expect(mode(target)).toBe(0o755);
		expect(ensurePrivateDir(link).success).toBe(true);
		expect(mode(target)).toBe(0o700);
	});

	test("a file in the way is an error", () => {
		const path = join(dir, "file");
		writeFileSync(path, "");
		expect(ensurePrivateDir(path).success).toBe(false);
	});
});

describe("privateTmpDir", () => {
	test("a short per-user directory", () => {
		expect(privateTmpDir({ platform: "darwin", uid: () => 501, tmpdir: () => "/var/folders/x/T" })).toBe(
			"/tmp/warden-501"
		);
		expect(privateTmpDir({ platform: "linux", uid: () => 1000, tmpdir: () => "/tmp" })).toBe("/tmp/warden-1000");
	});
});

describe("ensureSocketDir", () => {
	test("creates the socket's directory owner-only", () => {
		const socket = join(dir, "run", "a.sock");
		expect(ensureSocketDir(socket).success).toBe(true);
		expect(mode(join(dir, "run"))).toBe(0o700);
	});

	test("tightens an existing directory, and refuses a symlinked one", () => {
		const run = join(dir, "run");
		mkdirSync(run);
		chmodSync(run, 0o777);
		expect(ensureSocketDir(join(run, "a.sock")).success).toBe(true);
		expect(mode(run)).toBe(0o700);
		symlinkSync(run, join(dir, "link"));
		expect(ensureSocketDir(join(dir, "link", "a.sock")).success).toBe(false);
	});
});

describe("restrictFile", () => {
	test("an existing file becomes 0600; a missing one is ignored", () => {
		const path = join(dir, "warden.db");
		writeFileSync(path, "", { mode: 0o644 });
		restrictFile(path);
		expect(mode(path)).toBe(0o600);
		restrictFile(join(dir, "missing"));
		expect(existsSync(join(dir, "missing"))).toBe(false);
	});
});

describe("listenOwnerOnly", () => {
	test("a unix socket bound inside it is 0600 from the start, and the umask is put back", () => {
		const socketPath = join(dir, "a.sock");
		const before = process.umask();
		const listener = listenOwnerOnly(() => Bun.listen({ unix: socketPath, socket: { data() {} } }));
		try {
			expect(mode(socketPath)).toBe(0o600);
			expect(process.umask()).toBe(before);
		} finally {
			listener.stop(true);
		}
	});

	test("the umask is put back when listening throws", () => {
		const before = process.umask();
		expect(() =>
			listenOwnerOnly(() => {
				throw new Error("nope");
			})
		).toThrow("nope");
		expect(process.umask()).toBe(before);
	});
});

describe("restrictSocket", () => {
	test("chmods a bound socket to 0600", () => {
		const socketPath = join(dir, "b.sock");
		const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });
		try {
			chmodSync(socketPath, 0o666);
			restrictSocket(socketPath);
			expect(mode(socketPath)).toBe(0o600);
		} finally {
			listener.stop(true);
		}
	});
});
