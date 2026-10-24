import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { fakeApp, testProject } from "./builds.testing";
import { releaseKey } from "./fingerprint";
import { combineKey, jsInputsHash } from "./js-inputs";
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

/**
 * Fake `plutil -extract <key> raw -o - <file>`: the test plists are JSON objects; a missing key or
 * file fails like the real tool (exit 1).
 */
function fakePlutil(cmd: readonly string[]): ExecResult | undefined {
	if (cmd[0] !== "plutil" || cmd[1] !== "-extract") return undefined;
	try {
		const value = (JSON.parse(readFileSync(cmd[6] ?? "", "utf8")) as Record<string, unknown>)[cmd[2] ?? ""];
		if (typeof value === "string") return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
	} catch {}
	return { exitCode: 1, stdout: "", stderr: "No value at that key path or invalid key path" };
}

/** Give a fake `.app` its bundle id. */
function bundled(app: string, id = "com.x.app"): string {
	writeFileSync(join(app, "Info.plist"), JSON.stringify({ CFBundleIdentifier: id }));
	return app;
}

/** A DerivedData project dir whose `info.plist` records the workspace it builds. */
function derivedProject(dd: string, name: string, workspace: string): string {
	derivedFor(dd, name, workspace);
	return join(dd, name);
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
		const out = join(
			derivedProject(dd, "App-xyz", join(root, "ios", "App.xcworkspace")),
			"Build",
			"Products",
			"Release-iphonesimulator"
		);
		const exec: Exec = async (cmd) => {
			if (cmd[2] === "xcode-release") {
				bundled(fakeApp(out, "App.app"));
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return fakePlutil(cmd) ?? { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" };
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
		expect(res).toEqual({ success: true, data: { artifact: join(out, "App.app") } });
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
		expect(res).toEqual({ success: true, data: { artifact: join(s.out, "app-debug.apk") } });
		expect(s.calls).toContain(`${s.root} sh -c gradle-build`);
	});

	test("fingerprint changed during build, native dir already there → error (a real native edit)", async () => {
		const s = setup(["h2"]);
		mkdirSync(join(s.root, "android"), { recursive: true });
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
		expect(await s.run()).toEqual({ success: true, data: { artifact: release } });
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
		// an already prebuilt project: no mid-build `git status` snapshot, only the git facts' spawns
		mkdirSync(join(root, "ios"), { recursive: true });
		const envs: Array<Record<string, string | undefined> | undefined> = [];
		const gitCalls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			const joined = cmd.join(" ");
			if (cmd[0] === "git") {
				gitCalls.push(joined);
				return { exitCode: 0, stdout: `${root}\n${root}/.git\nrefs/heads/main\n`, stderr: "" };
			}
			if (joined === "xcode-select -p") return { exitCode: 0, stdout: "/X/Xcode.app/Contents/Developer\n", stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleShortVersionString"))
				return { exitCode: 0, stdout: "26.0\n", stderr: "" };
			if (joined.startsWith("plutil -extract ProductBuildVersion"))
				return { exitCode: 0, stdout: "17A400\n", stderr: "" };
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

describe("runLocalBuild: a fresh checkout's prebuild moves the fingerprint (17-1)", () => {
	const apkDir = (root: string) => join(root, "android", "app", "build", "outputs", "apk", "debug");

	/** Android host: the build creates `android/` (expo prebuild), `fp` prints `fingerprints` in turn, git status is `status()`. */
	function host(fingerprints: string[], status: () => string | undefined = () => "") {
		const root = join(dir, "app");
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (cmd[2] === "gradle-build") {
				mkdirSync(apkDir(root), { recursive: true });
				writeFileSync(join(apkDir(root), "app-debug.apk"), "apk");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[2] === "fp") return { exitCode: 0, stdout: `{"hash":"${fingerprints.shift()}"}`, stderr: "" };
			if (joined.startsWith("git status --porcelain")) {
				const out = status();
				return out === undefined
					? { exitCode: 128, stdout: "", stderr: "fatal" }
					: { exitCode: 0, stdout: out, stderr: "" };
			}
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "x", android: "gradle-build" } });
		return { root, calls, exec, project };
	}
	const base = { env: { HOME: "/nope" }, log: () => {} };

	test("the build created android/ and the tree is otherwise unchanged → ok, with the post-build key", async () => {
		const s = host(["h2"]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res).toEqual({ success: true, data: { artifact: join(apkDir(s.root), "app-debug.apk"), postKey: "h2" } });
		const status = s.calls.filter((c) => c.startsWith("git status"));
		expect(status).toHaveLength(2);
		expect(status[0]).toContain(":(exclude)android");
	});

	test("a source edit during the build (git status moved) → error", async () => {
		const states = ["", " M src/a.ts\n"];
		const s = host(["h2"], () => states.shift());
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint changed");
	});

	test("not a git checkout (no status to compare) → error", async () => {
		const s = host(["h2"], () => undefined);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res.success).toBe(false);
	});

	describe("JS-aware project", () => {
		const blob = (c: string) => c.repeat(40);
		/** `git ls-files` sees `src/a.ts` at `blobs()` (index first, then modified). */
		function jsHost(fingerprints: string[], blobs: string[]) {
			const s = host(fingerprints);
			const exec: Exec = async (cmd, opts) => {
				const joined = cmd.join(" ");
				if (joined.startsWith("git ls-files -z -v -s")) {
					s.calls.push(joined);
					return { exitCode: 0, stdout: `H 100644 ${blobs.shift()} 0\tsrc/a.ts\0`, stderr: "" };
				}
				if (joined.startsWith("git ls-files -z -m")) return { exitCode: 0, stdout: "", stderr: "" };
				return s.exec(cmd, opts);
			};
			return { ...s, exec, project: { ...s.project, jsInputs: ["src/**"] } };
		}
		const jsOf = async (id: string) => {
			const exec: Exec = async (cmd) =>
				cmd.includes("-s")
					? { exitCode: 0, stdout: `H 100644 ${id} 0\tsrc/a.ts\0`, stderr: "" }
					: { exitCode: 0, stdout: "", stderr: "" };
			const js = await jsInputsHash({ exec, root: "/r", jsInputs: ["src/**"] });
			if (!js.success) throw new Error(js.error);
			return js.data;
		};

		test("JS half unchanged → ok with the post-build key, no git status needed", async () => {
			const js = await jsOf(blob("a"));
			const s = jsHost(["n2"], [blob("a")]);
			const res = await runLocalBuild({
				...base,
				exec: s.exec,
				project: s.project,
				platform: "android",
				hash: combineKey("n1", js),
				native: "n1",
			});
			expect(res).toEqual({
				success: true,
				data: { artifact: join(apkDir(s.root), "app-debug.apk"), postKey: combineKey("n2", js) },
			});
			expect(s.calls.some((c) => c.startsWith("git status"))).toBe(false);
		});

		test("JS half changed during the build → error", async () => {
			const js = await jsOf(blob("a"));
			const s = jsHost(["n2"], [blob("b")]);
			const res = await runLocalBuild({
				...base,
				exec: s.exec,
				project: s.project,
				platform: "android",
				hash: combineKey("n1", js),
				native: "n1",
			});
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain("fingerprint changed");
		});
	});
});

describe("runLocalBuild: an up-to-date build leaves an old artifact (17-2)", () => {
	const RELEASE = join("android", "app", "build", "outputs", "apk");

	/** Release Android host whose build touches nothing (Gradle up to date) unless `during` says otherwise. */
	function host(fingerprint: string, during: (root: string) => void = () => {}) {
		const root = join(dir, "app");
		const outputs = join(root, RELEASE);
		mkdirSync(join(outputs, "release"), { recursive: true });
		const apk = join(outputs, "release", "app-release.apk");
		writeFileSync(apk, "apk");
		age(apk, 3600);
		const logs: string[] = [];
		const exec: Exec = async (cmd) => {
			if (cmd[2] === "gradle-build") {
				during(root);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[2] === "fp") return { exitCode: 0, stdout: `{"hash":"${fingerprint}"}`, stderr: "" };
			return { exitCode: 127, stdout: "", stderr: cmd.join(" ") };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			buildConfiguration: "Release",
			build: { ios: "x", android: "gradle-build" },
		});
		const deps = {
			exec,
			project,
			platform: "android" as const,
			hash: releaseKey("h1"),
			env: { HOME: "/nope" },
			log: (line: string) => logs.push(line),
		};
		return { root, outputs, apk, logs, deps };
	}

	test("old APK, build exit 0, fingerprint unchanged → the existing APK, logged", async () => {
		const s = host("h1");
		const res = await runLocalBuild(s.deps);
		expect(res).toEqual({ success: true, data: { artifact: s.apk } });
		expect(s.logs).toContain(`build was up to date; reusing ${s.apk}`);
	});

	test("a newer androidTest/release APK is never picked", async () => {
		const s = host("h1", (root) => {
			const test = join(root, RELEASE, "androidTest", "release");
			mkdirSync(test, { recursive: true });
			writeFileSync(join(test, "app-release-androidTest.apk"), "test apk");
		});
		const res = await runLocalBuild(s.deps);
		expect(res).toEqual({ success: true, data: { artifact: s.apk } });
	});

	test("fingerprint differs (native dir already there) → still an error", async () => {
		const s = host("h2");
		const res = await runLocalBuild(s.deps);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint changed");
	});

	test("iOS: an old .app is used only when its bundle id is the project's", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", SIM);
		const app = bundled(fakeApp(products, "App.app"));
		age(app, 3600);
		const exec: Exec = async (cmd) =>
			fakePlutil(cmd) ??
			(cmd[2] === "fp"
				? { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" }
				: { exitCode: 0, stdout: "", stderr: "" });
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "noop", android: "x" } });
		const deps = {
			exec,
			project,
			platform: "ios" as const,
			hash: "h1",
			env: { HOME: dir },
			log: () => {},
		};
		expect(await runLocalBuild({ ...deps, compilerCache: false })).toEqual({ success: true, data: { artifact: app } });
		bundled(app, "com.other.app");
		const other = await runLocalBuild({ ...deps, compilerCache: false });
		expect(other.success).toBe(false);
	});
});

describe("runLocalBuild: iOS artifacts from other projects (17-3)", () => {
	const PRODUCTS = join("Build", "Products", "Debug-iphonesimulator");

	function host(build: (root: string, dd: string) => void) {
		const root = join(dir, "app");
		const dd = join(dir, "Library", "Developer", "Xcode", "DerivedData");
		mkdirSync(join(root, "ios", "example.xcworkspace"), { recursive: true });
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			if (cmd[2] === "xb") {
				build(root, dd);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return (
				fakePlutil(cmd) ??
				(cmd[2] === "fp"
					? { exitCode: 0, stdout: '{"hash":"h1"}', stderr: "" }
					: { exitCode: 127, stdout: "", stderr: "" })
			);
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "xb", android: "x" } });
		const deps = {
			exec,
			project,
			platform: "ios" as const,
			hash: "h1",
			env: { HOME: dir },
			log: () => {},
			compilerCache: false,
		};
		return { root, dd, calls, deps };
	}
	const future = (path: string) => {
		const t = Date.now() / 1000 + 30;
		utimesSync(path, t, t);
	};

	test("a newer .app of another root's DerivedData project is ignored", async () => {
		let mine = "";
		const s = host((root, dd) => {
			mine = bundled(
				fakeApp(join(derivedProject(dd, "example-aaa", join(root, "ios", "example.xcworkspace")), PRODUCTS))
			);
			future(
				bundled(fakeApp(join(derivedProject(dd, "example-bbb", "/elsewhere/app/ios/example.xcworkspace"), PRODUCTS)))
			);
		});
		expect(await runLocalBuild(s.deps)).toEqual({ success: true, data: { artifact: mine } });
	});

	test("a .app with another bundle id (a UI test runner) is skipped", async () => {
		let app = "";
		const s = host((root) => {
			app = bundled(fakeApp(join(root, "ios", "build", PRODUCTS), "App.app"));
			future(bundled(fakeApp(join(root, "ios", "build", PRODUCTS), "AppUITests-Runner.app"), "com.x.app.xctrunner"));
		});
		expect(await runLocalBuild(s.deps)).toEqual({ success: true, data: { artifact: app } });
	});
});
