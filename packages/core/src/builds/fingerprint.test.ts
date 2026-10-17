import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { openStore, type Store } from "../store";
import { testProject } from "./builds.testing";
import {
	computeCacheKey,
	computeFingerprint,
	findFingerprintBin,
	fingerprintArgv,
	getFingerprintMemo,
	parseFingerprintOutput,
	releaseKey,
} from "./fingerprint";
import { combineKey } from "./js-inputs";

const HASH = "3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a";

describe("parseFingerprintOutput", () => {
	test("pretty JSON from fingerprint:generate", () => {
		const stdout = JSON.stringify({ hash: HASH, sources: [{ type: "dir" }] }, null, 2);
		expect(parseFingerprintOutput(stdout)).toEqual({ success: true, data: HASH });
	});

	test("last line JSON or bare hash (noisy script output)", () => {
		expect(parseFingerprintOutput(`$ fingerprint\nwarn: x\n{"hash":"${HASH}"}\n`)).toEqual({
			success: true,
			data: HASH,
		});
		expect(parseFingerprintOutput(`computing…\n${HASH}\n`)).toEqual({ success: true, data: HASH });
	});

	test("garbage → error", () => {
		expect(parseFingerprintOutput("").success).toBe(false);
		expect(parseFingerprintOutput("error: boom").success).toBe(false);
		expect(parseFingerprintOutput('{"nohash":1}').success).toBe(false);
	});

	test("JSON that is not `{ hash: <non-empty string> }` is no hash", () => {
		for (const text of ['{"hash":""}', '{"hash":5}', '[{"hash":"0123abcd"}]', "null", '"0123abcd"'])
			expect(parseFingerprintOutput(text).success).toBe(false);
		expect(parseFingerprintOutput('{"hash":"0123abcd","extra":1}')).toEqual({ success: true, data: "0123abcd" });
	});
});

describe("fingerprintArgv", () => {
	test("project command with {platform}", () => {
		const p = testProject({ fingerprintCommand: "bun run --silent fingerprint:{platform}" });
		expect(fingerprintArgv(p, "ios")).toEqual(["sh", "-c", "bun run --silent fingerprint:ios"]);
	});

	test("local bin, else bunx", () => {
		expect(fingerprintArgv(testProject(), "android", "/repo/node_modules/.bin/fingerprint")).toEqual([
			"/repo/node_modules/.bin/fingerprint",
			"fingerprint:generate",
			"--platform",
			"android",
		]);
		expect(fingerprintArgv(testProject(), "ios", undefined)).toEqual([
			"bunx",
			"--bun",
			"@expo/fingerprint",
			"fingerprint:generate",
			"--platform",
			"ios",
		]);
	});

	test("findFingerprintBin walks up to a hoisted node_modules", () => {
		const bin = findFingerprintBin("/repo/apps/a", (p) => p === "/repo/node_modules/.bin/fingerprint");
		expect(bin).toBe("/repo/node_modules/.bin/fingerprint");
		expect(findFingerprintBin("/repo/apps/a", () => false)).toBeUndefined();
	});
});

describe("computeFingerprint", () => {
	test("runs in the project root and parses the hash", async () => {
		const seen: Array<{ cmd: readonly string[]; cwd?: string }> = [];
		const exec: Exec = async (cmd, opts) => {
			seen.push({ cmd, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
			return { exitCode: 0, stdout: JSON.stringify({ hash: HASH }), stderr: "" };
		};
		const res = await computeFingerprint(exec, testProject({ fingerprintCommand: "fp {platform}" }), "ios");
		expect(res).toEqual({ success: true, data: HASH });
		expect(seen).toEqual([{ cmd: ["sh", "-c", "fp ios"], cwd: "/repo/app" }]);
	});

	test("non-zero exit → error", async () => {
		const exec: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "Cannot find module" });
		const res = await computeFingerprint(exec, testProject({ fingerprintCommand: "fp" }), "ios");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("Cannot find module");
	});
});

describe("computeCacheKey", () => {
	function host(js: string) {
		const exec: Exec = async (cmd) => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: cmd.includes("-m") ? "" : "? src/a.ts", stderr: "" };
			return { exitCode: 0, stdout: `{"hash":"${HASH}"}`, stderr: "" };
		};
		const readFile = async () => new TextEncoder().encode(js);
		return { exec, readFile };
	}

	test("native projects: the key is the native fingerprint", async () => {
		const h = host("a");
		const res = await computeCacheKey(h.exec, testProject({ fingerprintCommand: "fp" }), "ios", h.readFile);
		expect(res).toEqual({ success: true, data: { key: HASH, native: HASH } });
	});

	test("native+js: the key covers the JS sources, the native hash stays separate", async () => {
		const project = testProject({ fingerprintCommand: "fp", jsInputs: ["src/**"] });
		const a = await computeCacheKey(host("a").exec, project, "ios", host("a").readFile);
		const b = await computeCacheKey(host("b").exec, project, "ios", host("b").readFile);
		if (!a.success || !b.success) throw new Error("expected keys");
		expect(a.data.native).toBe(HASH);
		expect(a.data.js).toBeDefined();
		expect(a.data.key).toBe(combineKey(HASH, a.data.js ?? ""));
		expect(a.data.key).not.toBe(b.data.key);
		expect(a.data.native).toBe(b.data.native);
	});

	test("the native fingerprint and the JS-input listing start together, not one after the other", async () => {
		const started: string[] = [];
		const gate = Promise.withResolvers<void>();
		const exec: Exec = async (cmd) => {
			started.push(cmd[0] === "git" ? "git" : "fingerprint");
			await gate.promise;
			if (cmd[0] === "git") return { exitCode: 0, stdout: cmd.includes("-m") ? "" : "? src/a.ts", stderr: "" };
			return { exitCode: 0, stdout: `{"hash":"${HASH}"}`, stderr: "" };
		};
		const project = testProject({ fingerprintCommand: "fp", jsInputs: ["src/**"] });
		const pending = computeCacheKey(exec, project, "ios", async () => new TextEncoder().encode("a"));
		await Bun.sleep(0);
		expect(started.sort()).toEqual(["fingerprint", "git", "git"]);
		gate.resolve();
		const res = await pending;
		expect(res.success).toBe(true);
	});

	test("a failing native fingerprint wins over the JS half, whichever finishes first", async () => {
		const exec: Exec = async (cmd) => {
			if (cmd[0] === "git") return { exitCode: 128, stdout: "", stderr: "not a git repository" };
			return { exitCode: 1, stdout: "", stderr: "Cannot find module" };
		};
		const project = testProject({ fingerprintCommand: "fp", jsInputs: ["src/**"] });
		const res = await computeCacheKey(exec, project, "ios");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint failed");
	});

	test("native-only projects never list git", async () => {
		const seen: string[] = [];
		const exec: Exec = async (cmd) => {
			seen.push(cmd[0] ?? "");
			return { exitCode: 0, stdout: `{"hash":"${HASH}"}`, stderr: "" };
		};
		await computeCacheKey(exec, testProject({ fingerprintCommand: "fp" }), "ios");
		expect(seen).toEqual(["sh"]);
	});

	test("a native-only Release key differs from the Debug one (same native hash, different binary)", async () => {
		const h = host("a");
		const res = await computeCacheKey(
			h.exec,
			testProject({ fingerprintCommand: "fp", buildConfiguration: "Release" }),
			"ios",
			h.readFile
		);
		if (!res.success) throw new Error(res.error);
		expect(res.data.native).toBe(HASH);
		expect(res.data.key).not.toBe(HASH);
		expect(res.data.key).toBe(releaseKey(HASH));
	});
});

describe("computeCacheKey fingerprint memo (17-5)", () => {
	let dir: string;
	let root: string;
	let top: string;
	let store: Store;
	let status: string;
	let head: string;
	let spawns: number;

	const exec: Exec = async (cmd) => {
		if (cmd[0] === "git" && cmd[1] === "rev-parse") return { exitCode: 0, stdout: `${top}\n${head}\n`, stderr: "" };
		if (cmd[0] === "git" && cmd[1] === "status") return { exitCode: 0, stdout: status, stderr: "" };
		if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
		spawns++;
		return { exitCode: 0, stdout: `{"hash":"${HASH}${spawns}"}`, stderr: "" };
	};
	const project = () => testProject({ root });
	const key = (p = project()) => computeCacheKey(exec, p, "ios", undefined, { store, now: 1 });
	/** set `path`'s mtime to `s` seconds (deterministic, no same-millisecond flakes) */
	const touch = (path: string, s: number) => utimesSync(path, s, s);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-fp-memo-"));
		root = join(dir, "repo");
		top = root;
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "app.json"), '{"expo":{}}');
		writeFileSync(join(root, "bun.lock"), "lock-v1");
		writeFileSync(join(root, "node_modules", ".bun-tag"), "");
		for (const f of ["app.json", "bun.lock", "node_modules/.bun-tag", "node_modules"]) touch(join(root, f), 1000);
		store = openStore(join(dir, "warden.db"));
		status = "";
		head = "aaaa";
		spawns = 0;
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("a second call with an unchanged signature spawns no fingerprint", async () => {
		const a = await key();
		const b = await key();
		expect(spawns).toBe(1);
		expect(b).toEqual(a);
		expect(a).toEqual({ success: true, data: { key: `${HASH}1`, native: `${HASH}1` } });
		expect(getFingerprintMemo(store, project(), "ios")?.native).toBe(`${HASH}1`);
	});

	test("the Release salt and the JS half still apply to a memoised native hash", async () => {
		await key();
		const res = await key(testProject({ root, buildConfiguration: "Release" }));
		expect(spawns).toBe(1);
		expect(res).toEqual({ success: true, data: { key: releaseKey(`${HASH}1`), native: `${HASH}1` } });
	});

	test("without a memo (the post-build recompute in runLocalBuild) it always spawns", async () => {
		await key();
		await computeCacheKey(exec, project(), "ios");
		expect(spawns).toBe(2);
	});

	test("a new HEAD recomputes", async () => {
		await key();
		head = "bbbb";
		await key();
		expect(spawns).toBe(2);
	});

	test("an added untracked file recomputes", async () => {
		await key();
		writeFileSync(join(root, "new.ts"), "x");
		status = "?? new.ts\0";
		await key();
		expect(spawns).toBe(2);
	});

	test("editing an already-dirty file again recomputes (same status line, new mtime)", async () => {
		writeFileSync(join(root, "plugin.js"), "a");
		touch(join(root, "plugin.js"), 1000);
		status = " M plugin.js\0";
		await key();
		touch(join(root, "plugin.js"), 2000);
		await key();
		expect(spawns).toBe(2);
	});

	test("touching the lockfile recomputes", async () => {
		await key();
		touch(join(root, "bun.lock"), 2000);
		await key();
		expect(spawns).toBe(2);
	});

	test("a lockfile in a parent dir up to the git toplevel (hoisted monorepo) is part of the signature", async () => {
		top = dir;
		writeFileSync(join(dir, "bun.lock"), "root-lock");
		touch(join(dir, "bun.lock"), 1000);
		await key();
		touch(join(dir, "bun.lock"), 2000);
		await key();
		expect(spawns).toBe(2);
	});

	test("a reinstall (node_modules marker) recomputes", async () => {
		await key();
		touch(join(root, "node_modules", ".bun-tag"), 2000);
		await key();
		expect(spawns).toBe(2);
	});

	test("editing app.json recomputes", async () => {
		await key();
		writeFileSync(join(root, "app.json"), '{"expo":{"name":"b"}}');
		touch(join(root, "app.json"), 1000);
		await key();
		expect(spawns).toBe(2);
	});

	test("creating ios/ (git-ignored under CNG) recomputes, and so does a change inside it", async () => {
		await key();
		mkdirSync(join(root, "ios", "App"), { recursive: true });
		writeFileSync(join(root, "ios", "App", "AppDelegate.swift"), "a");
		await key();
		expect(spawns).toBe(2);
		await key();
		expect(spawns).toBe(2);
		touch(join(root, "ios", "App", "AppDelegate.swift"), 5000);
		await key();
		expect(spawns).toBe(3);
	});

	test("ios/Pods and android/build churn does not recompute (the fingerprint ignores them too)", async () => {
		mkdirSync(join(root, "ios", "Pods"), { recursive: true });
		mkdirSync(join(root, "android", "build"), { recursive: true });
		await key();
		writeFileSync(join(root, "ios", "Pods", "x"), "x");
		writeFileSync(join(root, "android", "build", "y"), "y");
		touch(join(root, "ios", "Pods"), 9000);
		touch(join(root, "android", "build"), 9000);
		await key();
		expect(spawns).toBe(1);
	});

	test("a project fingerprint.command is never memoised", async () => {
		const p = testProject({ root, fingerprintCommand: "fp {platform}" });
		await key(p);
		await key(p);
		expect(spawns).toBe(2);
	});

	test("an app config that reads process.env is never memoised", async () => {
		writeFileSync(join(root, "app.config.ts"), "export default { name: process.env.APP_NAME };");
		await key();
		await key();
		expect(spawns).toBe(2);
	});

	test("outside a git checkout it fingerprints every time", async () => {
		const noGit: Exec = async (cmd) => {
			if (cmd[0] === "git") return { exitCode: 128, stdout: "", stderr: "not a git repository" };
			spawns++;
			return { exitCode: 0, stdout: `{"hash":"${HASH}"}`, stderr: "" };
		};
		await computeCacheKey(noGit, project(), "ios", undefined, { store, now: 1 });
		await computeCacheKey(noGit, project(), "ios", undefined, { store, now: 1 });
		expect(spawns).toBe(2);
	});

	test("another platform or variant is its own memo row", async () => {
		await key();
		await computeCacheKey(exec, project(), "android", undefined, { store, now: 1 });
		await key(testProject({ root, variant: "staging" }));
		expect(spawns).toBe(3);
	});

	test("a tree that changed while the fingerprint ran is not memoised", async () => {
		const racing: Exec = async (cmd) => {
			if (cmd[0] !== "git") {
				touch(join(root, "bun.lock"), 7000 + spawns);
			}
			return exec(cmd);
		};
		await computeCacheKey(racing, project(), "ios", undefined, { store, now: 1 });
		expect(getFingerprintMemo(store, project(), "ios")).toBeUndefined();
	});
});
