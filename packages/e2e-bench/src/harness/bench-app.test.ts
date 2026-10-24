import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	benchAppDir,
	benchAppStatus,
	cleanBenchApp,
	ensureBenchApp,
	exportBenchApp,
	importBenchApp,
	readBenchApp,
	verifyBenchApp,
} from "./bench-app";
import { fakeExec } from "./exec";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "bench-pinned-"));
	dirs.push(d);
	return d;
}

const now = () => new Date("2026-10-24T00:00:00.000Z");
const ensured = (appPath: string) => JSON.stringify({ appPath, hash: "fp1", source: "cache", installed: false });

function fakeApk(root: string, body = "apk"): string {
	const p = join(root, "src", "Example.apk");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(p, body);
	return p;
}

function fakeAppDir(root: string): string {
	const p = join(root, "src", "Example.app");
	mkdirSync(join(p, "Frameworks"), { recursive: true });
	writeFileSync(join(p, "Info.plist"), "plist");
	writeFileSync(join(p, "Frameworks", "x.dylib"), "lib");
	return p;
}

describe("benchAppDir", () => {
	test("is .bench/app/<platform> under the repo root", () => {
		expect(benchAppDir("/r", "android")).toBe("/r/.bench/app/android");
	});
});

describe("exportBenchApp / readBenchApp", () => {
	test("exports an apk with a manifest and reads it back", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "android");
		const out = await exportBenchApp({
			from: fakeApk(root),
			platform: "android",
			bundleId: "b.id",
			hash: "fp1",
			source: "cache",
			dir,
			now,
			commit: "abc123",
		});
		expect(out.success).toBe(true);
		const read = readBenchApp(dir);
		expect(read.success && read.data.manifest).toMatchObject({
			schemaVersion: 1,
			platform: "android",
			bundleId: "b.id",
			artifact: "Example.apk",
			hash: "fp1",
			source: "cache",
			bytes: 3,
			builtAt: "2026-10-24T00:00:00.000Z",
			commit: "abc123",
		});
		expect(read.success && read.data.appPath).toBe(join(dir, "Example.apk"));
		expect(existsSync(`${dir}.tmp`)).toBe(false);
	});

	test("exports a .app dir recursively and replaces the old dir", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "ios");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "stale.txt"), "old");
		const base = { platform: "ios" as const, bundleId: "b", hash: "h", source: "build" as const, dir, now };
		const out = await exportBenchApp({ ...base, from: fakeAppDir(root) });
		expect(out.success).toBe(true);
		expect(existsSync(join(dir, "stale.txt"))).toBe(false);
		expect(existsSync(join(dir, "Example.app", "Frameworks", "x.dylib"))).toBe(true);
		const read = readBenchApp(dir);
		expect(read.success && verifyBenchApp(read.data).success).toBe(true);
	});

	test("a missing source is an error and leaves the old dir alone", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "android");
		await exportBenchApp({
			from: fakeApk(root),
			platform: "android",
			bundleId: "b",
			hash: "h",
			source: "cache",
			dir,
			now,
		});
		const out = await exportBenchApp({
			from: join(root, "nope.apk"),
			platform: "android",
			bundleId: "b",
			hash: "h2",
			source: "cache",
			dir,
			now,
		});
		expect(out.success).toBe(false);
		const read = readBenchApp(dir);
		expect(read.success && read.data.manifest.hash).toBe("h");
	});

	test("readBenchApp: missing dir, bad manifest, missing artifact", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "ios");
		const missing = readBenchApp(dir);
		expect(!missing.success && missing.error).toContain("run `bun run bench app build --platform ios`");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "manifest.json"), "{nope");
		expect(readBenchApp(dir).success).toBe(false);
		await exportBenchApp({ from: fakeApk(root), platform: "ios", bundleId: "b", hash: "h", source: "cache", dir, now });
		rmSync(join(dir, "Example.apk"));
		const gone = readBenchApp(dir);
		expect(!gone.success && gone.error).toContain("Example.apk");
	});
});

describe("verifyBenchApp", () => {
	test("fails when the artifact changed since the build", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "android");
		await exportBenchApp({
			from: fakeApk(root),
			platform: "android",
			bundleId: "b",
			hash: "h",
			source: "cache",
			dir,
			now,
		});
		const read = readBenchApp(dir);
		if (!read.success) throw new Error(read.error);
		writeFileSync(read.data.appPath, "tampered");
		const v = verifyBenchApp(read.data);
		expect(!v.success && v.error).toMatch(/changed since it was built.*rebuild/);
	});
});

describe("importBenchApp", () => {
	test("pins a bare artifact with an import: hash", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "android");
		const out = await importBenchApp({ path: fakeApk(root), platform: "android", dir, now });
		expect(out.success && out.data.manifest.source).toBe("import");
		expect(out.success && out.data.manifest.hash).toBe(
			`import:${out.success ? out.data.manifest.sha256.slice(0, 12) : ""}`
		);
		expect(out.success && out.data.manifest.bundleId).toBe("nz.co.delacour.warden.example");
	});
});

describe("ensureBenchApp", () => {
	const input = (root: string, extra: { force?: boolean; eas?: boolean } = {}) => ({
		platform: "android" as const,
		repoRoot: root,
		cliPath: "/cli.ts",
		force: extra.force ?? false,
		eas: extra.eas ?? false,
		now,
		log: () => undefined,
	});

	test("builds once via warden app ensure --no-install, then reuses without spawning", async () => {
		const root = tmp();
		const apk = fakeApk(root);
		const exec = fakeExec([
			{ cmd: process.execPath, match: (a) => a[1] === "app", result: { stdout: ensured(apk) } },
			{ cmd: "git", result: { stdout: "deadbeef\n" } },
		]);
		const first = await ensureBenchApp(exec, input(root));
		expect(first.success && first.data.reused).toBe(false);
		expect(first.success && first.data.manifest).toMatchObject({ hash: "fp1", source: "cache", commit: "deadbeef" });
		const ensure = exec.calls.find((c) => c.cmd === process.execPath);
		expect(ensure?.args).toEqual([
			"/cli.ts",
			"app",
			"ensure",
			"android",
			"--project",
			join(root, "apps/example"),
			"--variant",
			"bench",
			"--no-install",
			"--no-eas",
			"--json",
		]);
		const before = exec.calls.length;
		const second = await ensureBenchApp(exec, input(root));
		expect(second.success && second.data.reused).toBe(true);
		expect(exec.calls).toHaveLength(before);
	});

	test("force rebuilds; eas drops --no-eas", async () => {
		const root = tmp();
		const apk = fakeApk(root);
		const exec = fakeExec([{ cmd: process.execPath, result: { stdout: ensured(apk) } }]);
		await ensureBenchApp(exec, input(root));
		const again = await ensureBenchApp(exec, input(root, { force: true, eas: true }));
		expect(again.success && again.data.reused).toBe(false);
		expect(exec.calls.at(-1)?.args).not.toContain("--no-eas");
	});

	test("empty appPath is an error and pins nothing", async () => {
		const root = tmp();
		const exec = fakeExec([{ cmd: process.execPath, result: { stdout: ensured("") } }]);
		const r = await ensureBenchApp(exec, input(root));
		expect(r.success).toBe(false);
		expect(readBenchApp(benchAppDir(root, "android")).success).toBe(false);
	});

	test("warden failure and garbage output", async () => {
		const root = tmp();
		expect(
			(await ensureBenchApp(fakeExec([{ cmd: process.execPath, result: { code: 1 } }]), input(root))).success
		).toBe(false);
		expect(
			(await ensureBenchApp(fakeExec([{ cmd: process.execPath, result: { stdout: "x" } }]), input(root))).success
		).toBe(false);
	});
});

describe("benchAppStatus", () => {
	const fp = (ios: string) => JSON.stringify({ fingerprints: { android: ios } });

	async function pinned(root: string, hash: string, source: "cache" | "import" = "cache") {
		await exportBenchApp({
			from: fakeApk(root),
			platform: "android",
			bundleId: "b",
			hash,
			source,
			dir: benchAppDir(root, "android"),
			now,
		});
	}
	const args = (root: string) => ({ platform: "android" as const, repoRoot: root, cliPath: "/cli.ts" });

	test("missing", async () => {
		const r = await benchAppStatus(fakeExec(), args(tmp()));
		expect(r).toEqual({ success: true, data: { state: "missing" } });
	});

	test("fresh and stale by fingerprint", async () => {
		const root = tmp();
		await pinned(root, "fp1");
		const fresh = await benchAppStatus(
			fakeExec([{ cmd: process.execPath, result: { stdout: fp("fp1") } }]),
			args(root)
		);
		expect(fresh.success && fresh.data.state).toBe("fresh");
		const exec = fakeExec([{ cmd: process.execPath, result: { stdout: fp("fp2") } }]);
		const stale = await benchAppStatus(exec, args(root));
		expect(stale.success && stale.data).toMatchObject({ state: "stale", currentHash: "fp2" });
		expect(exec.calls[0]?.args).toEqual([
			"/cli.ts",
			"app",
			"fingerprint",
			"android",
			"--project",
			join(root, "apps/example"),
			"--variant",
			"bench",
			"--json",
		]);
	});

	test("unknown for an import hash or a failing fingerprint", async () => {
		const root = tmp();
		await pinned(root, "import:abc", "import");
		const imported = await benchAppStatus(fakeExec(), args(root));
		expect(imported.success && imported.data.state).toBe("unknown");
		await pinned(root, "fp1");
		const failing = await benchAppStatus(fakeExec([{ cmd: process.execPath, result: { code: 1 } }]), args(root));
		expect(failing.success && failing.data.state).toBe("unknown");
	});
});

describe("cleanBenchApp", () => {
	test("removes the dir and tolerates a missing one", async () => {
		const root = tmp();
		const dir = benchAppDir(root, "android");
		await importBenchApp({ path: fakeApk(root), platform: "android", dir, now });
		cleanBenchApp(dir);
		expect(existsSync(dir)).toBe(false);
		expect(() => cleanBenchApp(dir)).not.toThrow();
	});
});
