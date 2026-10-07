import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { testProject } from "./builds.testing";
import {
	computeCacheKey,
	computeFingerprint,
	findFingerprintBin,
	fingerprintArgv,
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
			if (cmd[0] === "git") return { exitCode: 0, stdout: "src/a.ts", stderr: "" };
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
