import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { ccacheCleanup, compilerCacheEnv, parseXcodeMajor } from "./compiler-cache";

const base = { wardenHome: "/w", gitTop: "/repo", xcodeMajor: 26, enabled: true, baseEnv: {} };

describe("compilerCacheEnv", () => {
	test("disabled → empty", () => {
		expect(compilerCacheEnv({ ...base, platform: "ios", enabled: false })).toEqual({});
		expect(compilerCacheEnv({ ...base, platform: "android", enabled: false })).toEqual({});
	});

	test("iOS: ccache vars + Xcode 26 caching", () => {
		const env = compilerCacheEnv({ ...base, platform: "ios" });
		expect(env).toMatchObject({
			USE_CCACHE: "1",
			CCACHE_DIR: "/w/ccache",
			CCACHE_BASEDIR: "/repo",
			CCACHE_FILECLONE: "true",
			CCACHE_NOHASHDIR: "true",
			COMPILATION_CACHE_ENABLE_CACHING: "YES",
		});
		expect(env.CCACHE_SLOPPINESS).toContain("time_macros");
	});

	test("iOS: Xcode < 26 or unknown skips Xcode caching; no git top skips BASEDIR", () => {
		expect(
			compilerCacheEnv({ ...base, platform: "ios", xcodeMajor: 16 }).COMPILATION_CACHE_ENABLE_CACHING
		).toBeUndefined();
		expect(
			compilerCacheEnv({ ...base, platform: "ios", xcodeMajor: undefined }).COMPILATION_CACHE_ENABLE_CACHING
		).toBeUndefined();
		expect(compilerCacheEnv({ ...base, platform: "ios", gitTop: undefined }).CCACHE_BASEDIR).toBeUndefined();
	});

	test("iOS: CCACHE_BINARY as a real env var, so React Native's ccache-clang.sh wrapper finds ccache", () => {
		// RN writes CCACHE_BINARY as an Xcode build setting, which never reaches the compiler's env: the wrapper then
		// runs plain clang and the cache stays empty
		expect(compilerCacheEnv({ ...base, platform: "ios", ccacheBinary: "/opt/homebrew/bin/ccache" }).CCACHE_BINARY).toBe(
			"/opt/homebrew/bin/ccache"
		);
		expect(compilerCacheEnv({ ...base, platform: "ios" }).CCACHE_BINARY).toBeUndefined();
		expect(
			compilerCacheEnv({ ...base, platform: "android", ccacheBinary: "/opt/homebrew/bin/ccache" }).CCACHE_BINARY
		).toBeUndefined();
	});

	test("Android: appends to existing GRADLE_OPTS", () => {
		expect(compilerCacheEnv({ ...base, platform: "android" })).toEqual({ GRADLE_OPTS: "-Dorg.gradle.caching=true" });
		expect(compilerCacheEnv({ ...base, platform: "android", baseEnv: { GRADLE_OPTS: "-Xmx2g" } })).toEqual({
			GRADLE_OPTS: "-Xmx2g -Dorg.gradle.caching=true",
		});
	});
});

describe("parseXcodeMajor", () => {
	test("parses xcodebuild -version", () => {
		expect(parseXcodeMajor("Xcode 26.0.1\nBuild version 17A400")).toBe(26);
		expect(parseXcodeMajor("garbage")).toBeUndefined();
	});
});

describe("ccacheCleanup", () => {
	test("runs ccache --cleanup with CCACHE_DIR; failure/throw → false", async () => {
		const calls: Array<{ cmd: readonly string[]; dir: string | undefined }> = [];
		const ok: Exec = async (cmd, o) => {
			calls.push({ cmd, dir: o?.env?.CCACHE_DIR });
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		expect(await ccacheCleanup(ok, "/w")).toBe(true);
		expect(calls[0]).toEqual({ cmd: ["ccache", "--cleanup"], dir: "/w/ccache" });
		expect(await ccacheCleanup(async () => ({ exitCode: 1, stdout: "", stderr: "" }), "/w")).toBe(false);
		expect(
			await ccacheCleanup(async () => {
				throw new Error("ENOENT");
			}, "/w")
		).toBe(false);
	});
});
