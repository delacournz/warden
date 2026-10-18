import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { fakeApp, testProject } from "./builds.testing";
import { releaseKey } from "./fingerprint";
import { artifactCandidates, locateArtifact, runLocalBuild, snapshotArtifacts } from "./local";

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

/** Mark DerivedData project dir `dd/<name>` as Xcode's build dir for `workspace`. */
function derivedFor(dd: string, name: string, workspace: string): void {
	mkdirSync(join(dd, name), { recursive: true });
	writeFileSync(
		join(dd, name, "info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>WorkspacePath</key>\n\t<string>${workspace}</string>\n</dict>\n</plist>\n`
	);
}

const NOTHING = new Map<string, number>();

describe("locateArtifact", () => {
	test("iOS: newest .app across ios/build and DerivedData, after the build start", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const old = fakeApp(join(dd, "Other-abc", SIM), "Other.app");
		derivedFor(dd, "App-xyz", join(root, "ios", "App.xcworkspace"));
		const fresh = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		const local = fakeApp(join(root, "ios", "build", SIM), "Local.app");
		age(old, 3600);
		age(local, 60);
		age(fresh, 5);
		expect(artifactCandidates(root, "ios", dd).sort()).toEqual([fresh, local, old].sort());
		expect(locateArtifact(root, "ios", dd, NOTHING)).toEqual({ kind: "rebuilt", path: fresh });
	});

	test("a candidate rewritten during the build beats a newer-looking unchanged one", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const kept = fakeApp(join(root, "ios", "build", SIM), "Kept.app");
		derivedFor(dd, "App-xyz", join(root, "ios", "App.xcworkspace"));
		const rebuilt = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		age(rebuilt, 60);
		age(kept, 5);
		const before = snapshotArtifacts(root, "ios", dd);
		age(rebuilt, 30);
		expect(locateArtifact(root, "ios", dd, before)).toEqual({ kind: "rebuilt", path: rebuilt });
	});

	test("Android: an up-to-date apk the build did not rewrite is still found", () => {
		const out = join(dir, "android", "app", "build", "outputs", "apk", "release");
		mkdirSync(out, { recursive: true });
		const apk = join(out, "app-release.apk");
		writeFileSync(apk, "apk");
		age(apk, 3600);
		const before = snapshotArtifacts(dir, "android", join(dir, "dd"), "Release");
		expect(before.get(apk)).toBeGreaterThan(0);
		expect(locateArtifact(dir, "android", join(dir, "dd"), before, "Release")).toEqual({
			kind: "up-to-date",
			path: apk,
		});
	});

	test("iOS: an unchanged .app is taken from this project's DerivedData, never another workspace's", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		derivedFor(dd, "Other-abc", join(dir, "other", "ios", "Other.xcworkspace"));
		derivedFor(dd, "Nested-def", join(root, ".claude", "worktrees", "x", "ios", "App.xcworkspace"));
		const foreign = fakeApp(join(dd, "Other-abc", SIM), "Other.app");
		const nested = fakeApp(join(dd, "Nested-def", SIM), "App.app");
		expect(locateArtifact(root, "ios", dd, snapshotArtifacts(root, "ios", dd))).toBeUndefined();

		derivedFor(dd, "App-xyz", join(root, "ios", "App&amp;Co.xcworkspace"));
		const own = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		age(own, 60);
		age(foreign, 5);
		age(nested, 5);
		expect(locateArtifact(root, "ios", dd, snapshotArtifacts(root, "ios", dd))).toEqual({
			kind: "up-to-date",
			path: own,
		});
	});

	test("iOS: the root is matched through symlinks (/var vs /private/var)", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const link = join(dir, "link");
		mkdirSync(join(root, "ios"), { recursive: true });
		symlinkSync(root, link);
		derivedFor(dd, "App-xyz", join(realpathSync(root), "ios", "App.xcworkspace"));
		const own = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		expect(locateArtifact(link, "ios", dd, snapshotArtifacts(link, "ios", dd))).toEqual({
			kind: "up-to-date",
			path: own,
		});
	});

	test("a foreign .app rewritten during an up-to-date build loses to this project's own", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		derivedFor(dd, "Other-abc", join(dir, "other", "ios", "Other.xcworkspace"));
		const foreign = fakeApp(join(dd, "Other-abc", SIM), "Other.app");
		const own = fakeApp(join(root, "ios", "build", SIM), "App.app");
		age(own, 3600);
		age(foreign, 3600);
		const before = snapshotArtifacts(root, "ios", dd);
		age(foreign, 1);
		expect(locateArtifact(root, "ios", dd, before)).toEqual({ kind: "up-to-date", path: own });
	});

	test("rewritten output of unknown owner is still taken when nothing of ours is there", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const before = snapshotArtifacts(root, "ios", dd);
		const fresh = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		expect(locateArtifact(root, "ios", dd, before)).toEqual({ kind: "rebuilt", path: fresh });
	});

	test("Android: two unchanged release flavors are ambiguous", () => {
		const apks = join(dir, "android", "app", "build", "outputs", "apk");
		const paths = ["fooRelease", "barRelease"].map((v) => {
			mkdirSync(join(apks, v), { recursive: true });
			writeFileSync(join(apks, v, `app-${v}.apk`), "apk");
			return join(apks, v, `app-${v}.apk`);
		});
		const dd = join(dir, "dd");
		const res = locateArtifact(dir, "android", dd, snapshotArtifacts(dir, "android", dd, "Release"), "Release");
		expect(res?.kind).toBe("ambiguous");
		if (res?.kind === "ambiguous") expect(res.paths.sort()).toEqual(paths.sort());
	});

	test("iOS: a DerivedData dir without a readable WorkspacePath is not ours", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		fakeApp(join(dd, "App-xyz", SIM), "App.app");
		expect(locateArtifact(root, "ios", dd, snapshotArtifacts(root, "ios", dd))).toBeUndefined();
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
		expect(locateArtifact(dir, "android", join(dir, "dd"), NOTHING)).toEqual({
			kind: "rebuilt",
			path: join(out, "app-debug.apk"),
		});
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
	const base = { env: { HOME: "/nope" }, log: () => {} };

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

	/** A Release project whose build command leaves `android/` untouched (Gradle: every task UP-TO-DATE). */
	function upToDate(exitCode: number) {
		const root = join(dir, "app");
		const apks = join(root, "android", "app", "build", "outputs", "apk");
		const logs: string[] = [];
		const exec: Exec = async (cmd) => {
			if (cmd[2] === "gradle-noop") return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "BUILD FAILED" };
			return { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			buildConfiguration: "Release",
			build: { ios: "x", android: "gradle-noop" },
		});
		const apk = (variant: string) => {
			mkdirSync(join(apks, variant), { recursive: true });
			const path = join(apks, variant, `app-${variant}.apk`);
			writeFileSync(path, "apk");
			age(path, 3600);
			return path;
		};
		const run = () =>
			runLocalBuild({
				exec,
				project,
				platform: "android",
				hash: releaseKey("h1"),
				env: { HOME: "/nope" },
				log: (line) => logs.push(line),
			});
		return { apk, run, logs };
	}

	test("an up-to-date Gradle build reuses the apk it did not rewrite", async () => {
		const s = upToDate(0);
		const release = s.apk("release");
		expect(await s.run()).toEqual({ success: true, data: release });
		expect(s.logs.some((l) => l.includes("up to date"))).toBe(true);
	});

	test("an up-to-date Release build never takes the debug apk", async () => {
		const s = upToDate(0);
		s.apk("debug");
		const res = await s.run();
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("no Release .apk was found");
	});

	test("an up-to-date build with two release flavors on disk refuses to guess", async () => {
		const s = upToDate(0);
		s.apk("fooRelease");
		s.apk("barRelease");
		const res = await s.run();
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("could be stale");
	});

	test("a failed build never falls back to the apk already on disk", async () => {
		const s = upToDate(1);
		s.apk("release");
		const res = await s.run();
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("BUILD FAILED");
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
		const gitCalls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			const joined = cmd.join(" ");
			if (cmd[0] === "git") {
				gitCalls.push(joined);
				return { exitCode: 0, stdout: `${root}\n${root}/.git\nrefs/heads/main\n`, stderr: "" };
			}
			if (joined === "xcodebuild -version") return { exitCode: 0, stdout: "Xcode 26.0\n", stderr: "" };
			if (cmd[2] === "xb") {
				envs.push(opts?.env);
				fakeApp(out, "A.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "xb", android: "x" } });
		return { root, envs, gitCalls, exec, project };
	}
	const common = { log: () => {} };

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

	test("the ccache base dir is the git facts' toplevel: one rev-parse, shared through the git cache", async () => {
		const s = iosSetup();
		const git = createGitFactsCache();
		await runLocalBuild({
			...common,
			exec: s.exec,
			project: s.project,
			platform: "ios",
			hash: "h1",
			env: { HOME: dir },
			wardenHome: "/w",
			git,
		});
		expect(s.gitCalls).toEqual(["git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD"]);
		expect(s.envs[0]?.CCACHE_BASEDIR).toBe(s.root);
	});

	test("facts the caller already read cost no git spawn at all", async () => {
		const s = iosSetup();
		const git = createGitFactsCache();
		git.store(s.root, { toplevel: s.root, commonDir: join(s.root, ".git"), branch: "main" });
		await runLocalBuild({
			...common,
			exec: s.exec,
			project: s.project,
			platform: "ios",
			hash: "h1",
			env: { HOME: dir },
			wardenHome: "/w",
			git,
		});
		expect(s.gitCalls).toEqual([]);
		expect(s.envs[0]?.CCACHE_BASEDIR).toBe(s.root);
	});

	test("a project outside any checkout still builds, with no ccache base dir", async () => {
		const s = iosSetup();
		const exec: Exec = async (cmd, opts) =>
			cmd[0] === "git" ? { exitCode: 128, stdout: "", stderr: "fatal" } : s.exec(cmd, opts);
		await runLocalBuild({
			...common,
			exec,
			project: s.project,
			platform: "ios",
			hash: "h1",
			env: { HOME: dir },
			wardenHome: "/w",
			git: createGitFactsCache(),
		});
		expect(s.envs[0]?.USE_CCACHE).toBe("1");
		expect(s.envs[0]?.CCACHE_BASEDIR).toBeUndefined();
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
