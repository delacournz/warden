import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putHost } from "@delacour/warden-core/hosts/registry";
import { type TestContext, testContext } from "../testing";
import { checkUpload, isUploadName, packTree, pruneUploads, receiveUpload, treeHash, uploadToHost } from "./upload";

const dirs: string[] = [];
const ctxs: TestContext[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const c of ctxs.splice(0)) c.cleanup();
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "warden-upload-"));
	dirs.push(d);
	return d;
}

function appBundle(root: string, body = "binary"): string {
	const app = join(root, "Example.app");
	mkdirSync(join(app, "Frameworks"), { recursive: true });
	writeFileSync(join(app, "Example"), body);
	chmodSync(join(app, "Example"), 0o755);
	writeFileSync(join(app, "Info.plist"), "<plist/>");
	writeFileSync(join(app, "Frameworks", "x.txt"), "x");
	return app;
}

describe("treeHash", () => {
	test("same files = same hash wherever they are; a changed byte or exec bit changes it", async () => {
		const a = appBundle(tmp());
		const b = appBundle(tmp());
		expect(await treeHash(a)).toBe(await treeHash(b));
		expect(await treeHash(a)).toMatch(/^[0-9a-f]{64}$/);
		const c = appBundle(tmp(), "binarY");
		expect(await treeHash(c)).not.toBe(await treeHash(a));
		chmodSync(join(b, "Example"), 0o644);
		expect(await treeHash(b)).not.toBe(await treeHash(a));
	});

	test("a single file (an .apk) hashes too", async () => {
		const f = join(tmp(), "app.apk");
		writeFileSync(f, "apk");
		expect(await treeHash(f)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("receiveUpload", () => {
	test("unpacks into uploads/<hash>/<name> after checking the hash; a second check finds it", async () => {
		const app = appBundle(tmp());
		const hash = await treeHash(app);
		const tar = await packTree(app, tmp());
		const home = tmp();
		expect(checkUpload(home, hash, "Example.app")).toEqual({
			present: false,
			path: join(home, "uploads", hash, "Example.app"),
		});
		const r = await receiveUpload(home, { hash, name: "Example.app" }, Bun.file(tar).stream());
		expect(r).toEqual({ success: true, data: join(home, "uploads", hash, "Example.app") });
		expect(readFileSync(join(home, "uploads", hash, "Example.app", "Example"), "utf8")).toBe("binary");
		expect(checkUpload(home, hash, "Example.app").present).toBe(true);
	});

	test("content that does not match the hash is refused and leaves nothing", async () => {
		const app = appBundle(tmp());
		const tar = await packTree(app, tmp());
		const home = tmp();
		const wrong = "0".repeat(64);
		const r = await receiveUpload(home, { hash: wrong, name: "Example.app" }, Bun.file(tar).stream());
		expect(!r.success && r.error).toContain("does not match");
		expect(existsSync(join(home, "uploads", wrong))).toBe(false);
	});

	test("uploads unused for longer than the keep window are pruned; a recent or kept one stays", () => {
		const home = tmp();
		for (const h of ["old", "new", "kept"]) mkdirSync(join(home, "uploads", h), { recursive: true });
		const now = Date.now();
		const old = new Date(now - 8 * 86_400_000);
		utimesSync(join(home, "uploads", "old"), old, old);
		utimesSync(join(home, "uploads", "kept"), old, old);
		expect(pruneUploads(home, now, 7 * 86_400_000, "kept")).toEqual(["old"]);
		expect(existsSync(join(home, "uploads", "new"))).toBe(true);
		expect(existsSync(join(home, "uploads", "kept"))).toBe(true);
	});

	test("names are one plain path segment", () => {
		expect(isUploadName("Example.app")).toBe(true);
		expect(isUploadName("app-release.apk")).toBe(true);
		for (const bad of ["", ".", "..", "a/b", "../x", "-rf"]) expect(isUploadName(bad)).toBe(false);
	});
});

describe("uploadToHost", () => {
	test("asks the host first; a build it already has is not sent again", async () => {
		const ctx = testContext([]);
		ctxs.push(ctx);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac.tail" }, addedAt: 1 });
		const app = appBundle(tmp());
		const hash = await treeHash(app);
		const sent: string[][] = [];
		ctx.exec = async (cmd) => {
			const remote = cmd.slice(cmd.indexOf("--") + 2);
			return {
				exitCode: 0,
				stdout: JSON.stringify({ present: true, path: `/h/uploads/${hash}/Example.app` }),
				stderr: remote.join(" "),
			};
		};
		const r = await uploadToHost(ctx, "mac", app, {
			upload: async (argv) => {
				sent.push([...argv]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(r).toEqual({ success: true, data: `/h/uploads/${hash}/Example.app` });
		expect(sent).toEqual([]);
	});

	test("a build the host lacks is packed and streamed to __host-recv", async () => {
		const ctx = testContext([]);
		ctxs.push(ctx);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac.tail" }, addedAt: 1 });
		const app = appBundle(tmp());
		const hash = await treeHash(app);
		ctx.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ present: false, path: "/h/x" }), stderr: "" });
		const sent: string[][] = [];
		const r = await uploadToHost(ctx, "mac", app, {
			upload: async (argv, file) => {
				sent.push([...argv]);
				expect(existsSync(file)).toBe(true);
				return { exitCode: 0, stdout: JSON.stringify({ path: `/h/uploads/${hash}/Example.app` }), stderr: "" };
			},
		});
		expect(r.success && r.data).toBe(`/h/uploads/${hash}/Example.app`);
		expect(sent[0]?.slice(-7)).toEqual(["warden", "__host-recv", "--hash", hash, "--name", "Example.app", "--json"]);
	});
});
