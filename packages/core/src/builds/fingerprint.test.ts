import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { testProject } from "./builds.testing";
import { computeFingerprint, findFingerprintBin, fingerprintArgv, parseFingerprintOutput } from "./fingerprint";

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
