import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { fakeApp, testProject } from "./builds.testing";
import { releaseKey } from "./fingerprint";
import { artifactCandidates, locateArtifact, runLocalBuild } from "./local";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-local-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SIM = join("Build", "Products", "Debug-iphonesimulator");

function age(path: string, secondsAgo: number): void {
	const t = Date.now() / 1000 - secondsAgo;
	utimesSync(path, t, t);
}

describe("locateArtifact", () => {
	test("iOS: newest .app across ios/build and DerivedData, after the build start", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const old = fakeApp(join(dd, "Other-abc", SIM), "Other.app");
		const fresh = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		const local = fakeApp(join(root, "ios", "build", SIM), "Local.app");
		age(old, 3600);
		age(local, 60);
		age(fresh, 5);
		expect(artifactCandidates(root, "ios", dd).sort()).toEqual([fresh, local, old].sort());
		expect(locateArtifact(root, "ios", dd, Date.now() - 120_000)).toBe(fresh);
		expect(locateArtifact(root, "ios", dd, Date.now() + 60_000)).toBeUndefined();
	});

	test("iOS: Release looks in Release-iphonesimulator only", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const debug = fakeApp(join(dd, "App-xyz", SIM), "Debug.app");
		const release = fakeApp(join(dd, "App-xyz", join("Build", "Products", "Release-iphonesimulator")), "Rel.app");
		const local = fakeApp(join(root, "ios", "build", join("Build", "Products", "Release-iphonesimulator")), "Loc.app");
		expect(artifactCandidates(root, "ios", dd, "Release").sort()).toEqual([local, release].sort());
		expect(artifactCandidates(root, "ios", dd).sort()).toEqual([debug]);
	});

	test("Android: Release picks only release apks", () => {
		const apk = join(dir, "android", "app", "build", "outputs", "apk");
		for (const variant of ["debug", "release"]) {
			mkdirSync(join(apk, variant), { recursive: true });
			writeFileSync(join(apk, variant, `app-${variant}.apk`), "apk");
		}
		expect(artifactCandidates(dir, "android", join(dir, "dd"), "Release")).toEqual([
			join(apk, "release", "app-release.apk"),
		]);
		expect(artifactCandidates(dir, "android", join(dir, "dd"), "Debug")).toEqual([join(apk, "debug", "app-debug.apk")]);
	});

	test("Android: .apk under android/app/build/outputs/apk", () => {
		const out = join(dir, "android", "app", "build", "outputs", "apk", "debug");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "app-debug.apk"), "apk");
		expect(locateArtifact(dir, "android", join(dir, "dd"), 0)).toBe(join(out, "app-debug.apk"));
	});
});

describe("runLocalBuild", () => {
	test("a Release build is found in Release-iphonesimulator", async () => {
		const root = join(dir, "app");
		const dd = join(dir, "Library", "Developer", "Xcode", "DerivedData");
		const out = join(dd, "App-xyz", "Build", "Products", "Release-iphonesimulator");
		const exec: Exec = async (cmd) => {
			if (cmd[2] === "xcode-release") {
				fakeApp(out, "App.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			buildConfiguration: "Release",
			build: { ios: "xcode-release", android: "x" },
		});
		const res = await runLocalBuild({
			exec,
			project,
			platform: "ios",
			hash: releaseKey("h1"),
			env: { HOME: dir },
			now: () => Date.now(),
			log: () => {},
		});
		expect(res).toEqual({ success: true, data: join(out, "App.app") });
	});

	function setup(fingerprints: string[]) {
		const root = join(dir, "app");
		const out = join(root, "android", "app", "build", "outputs", "apk", "debug");
		const calls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push(`${opts?.cwd} ${cmd.join(" ")}`);
			if (cmd[2] === "gradle-build") {
				mkdirSync(out, { recursive: true });
				writeFileSync(join(out, "app-debug.apk"), "apk");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[2] === "fp") return { exitCode: 0, stdout: `{"hash":"${fingerprints.shift()}"}`, stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "BUILD FAILED" };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			build: { ios: "xcode-fail", android: "gradle-build" },
		});
		return { root, out, calls, exec, project };
	}
	const base = { env: { HOME: "/nope" }, now: () => Date.now(), log: () => {} };

	test("builds, locates, verifies the fingerprint", async () => {
		const s = setup(["h1"]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res).toEqual({ success: true, data: join(s.out, "app-debug.apk") });
		expect(s.calls[0]).toBe(`${s.root} sh -c gradle-build`);
	});

	test("fingerprint changed during build → error", async () => {
		const s = setup(["h2"]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint changed");
	});

	test("build command fails → error", async () => {
		const s = setup([]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "ios", hash: "h1" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("BUILD FAILED");
	});
});

describe("runLocalBuild compiler cache env", () => {
	function iosSetup() {
		const root = join(dir, "app");
		const out = join(root, "ios", "build", SIM);
		const envs: Array<Record<string, string | undefined> | undefined> = [];
		const exec: Exec = async (cmd, opts) => {
			const joined = cmd.join(" ");
			if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
			if (joined === "xcodebuild -version") return { exitCode: 0, stdout: "Xcode 26.0\n", stderr: "" };
			if (cmd[2] === "xb") {
				envs.push(opts?.env);
				fakeApp(out, "A.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "xb", android: "x" } });
		return { root, envs, exec, project };
	}
	const common = { now: () => Date.now(), log: () => {} };

	test("iOS build gets ccache env", async () => {
		const s = iosSetup();
		await runLocalBuild({
			...common,
			exec: s.exec,
			project: s.project,
			platform: "ios",
			hash: "h1",
			env: { HOME: dir },
			wardenHome: "/w",
		});
		expect(s.envs[0]).toMatchObject({
			USE_CCACHE: "1",
			CCACHE_DIR: "/w/ccache",
			CCACHE_BASEDIR: s.root,
			COMPILATION_CACHE_ENABLE_CACHING: "YES",
			EXPO_NO_TELEMETRY: "1",
		});
	});

	test("compilerCache:false → no cache env", async () => {
		const s = iosSetup();
		await runLocalBuild({
			...common,
			exec: s.exec,
			project: s.project,
			platform: "ios",
			hash: "h1",
			env: { HOME: dir },
			compilerCache: false,
		});
		expect(s.envs[0]).toEqual({ EXPO_NO_TELEMETRY: "1" });
	});
});
