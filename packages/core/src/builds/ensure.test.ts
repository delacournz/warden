import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { openStore, type Store } from "../store";
import { EXPO_CONFIG_ARGV } from "./app-config";
import { fakeApp, testProject } from "./builds.testing";
import {
	cachedBuild,
	devDir,
	getBuild,
	getInstall,
	kindHash,
	recordInstall,
	simulatorBaseDir,
	storeArtifact,
} from "./cache";
import { JSON_CONFIG_FILE } from "./config";
import {
	type EnsureInput,
	type EnsureKindInput,
	ensureApp,
	ensureKindBuild,
	prebuildStamp,
	projectContext,
} from "./ensure";
import { computeCacheKey } from "./fingerprint";
import { projectForKind } from "./kinds";
import type { AppPhase } from "./resolve";

let dir: string;
let store: Store;
let env: Record<string, string>;
const KEY = "github.com/o/r:app";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ensure-"));
	env = { WARDEN_HOME: join(dir, "home"), HOME: join(dir, "user") };
	store = openStore(join(dir, "home", "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** `plutil -extract CFBundleIdentifier raw` of a built `.app`: the project's bundle id */
const BUNDLE_ID: ExecResult = { exitCode: 0, stdout: "com.x.app\n", stderr: "" };

/** every file is 7 bytes: installed and cached builds look the same */
const fileSize = async (): Promise<number> => 7;

function fake(handlers: Array<[string, Partial<ExecResult>]>, calls: string[]): Exec {
	return async (cmd) => {
		const joined = cmd.join(" ");
		calls.push(joined);
		const hit = handlers.find(([p]) => joined.startsWith(p));
		return hit ? { exitCode: 0, stdout: "", stderr: "", ...hit[1] } : { exitCode: 127, stdout: "", stderr: joined };
	};
}

function input(exec: Exec, over: Partial<EnsureInput> = {}): EnsureInput {
	return {
		store,
		exec,
		env,
		now: () => 5_000,
		sleep: async () => {},
		log: () => {},
		pidAlive: () => false,
		owner: { kind: "agent", sessionId: "me", cwd: dir },
		pid: 1,
		project: testProject({ root: join(dir, "app") }),
		projectKey: KEY,
		platform: "ios",
		hash: "H",
		deviceId: "U1",
		eas: false,
		build: false,
		...over,
	};
}

async function seedCache(hash = "H"): Promise<string> {
	const res = await storeArtifact({
		store,
		env,
		projectKey: KEY,
		platform: "ios",
		profile: "local",
		hash,
		artifact: fakeApp(join(dir, "src")),
		source: "import",
		now: 1,
	});
	if (!res.success) throw new Error(res.error);
	return res.data.path;
}

describe("ensureApp", () => {
	test("cache → install + record; second call → installed (no reinstall)", async () => {
		const path = await seedCache();
		const calls: string[] = [];
		const exec = fake(
			[
				["xcrun simctl install U1", {}],
				["xcrun simctl get_app_container U1 com.x.app", { stdout: "/data/App.app" }],
				["plutil -convert json", { stdout: JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }) }],
			],
			calls
		);
		const first = await ensureApp(input(exec, { fileSize }));
		expect(first).toEqual({ success: true, data: { appPath: path, hash: "H", source: "cache", installed: true } });
		expect(getInstall(store, "ios", "U1", "com.x.app")?.hash).toBe("H");
		expect(getBuild(store, KEY, "ios", "H")?.lastUsedAt).toBe(5_000);

		calls.length = 0;
		const second = await ensureApp(input(exec, { fileSize }));
		expect(second).toEqual({ success: true, data: { appPath: path, hash: "H", source: "installed", installed: true } });
		expect(calls[0]).toBe("xcrun simctl get_app_container U1 com.x.app");
		expect(calls.some((c) => c.startsWith("xcrun simctl install"))).toBe(false);
	});

	test("the already-installed check is three spawns: one get_app_container, two plutil, no stat", async () => {
		await seedCache();
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "com.x.app", hash: "H", installedAt: 1 });
		const calls: string[] = [];
		const exec = fake(
			[
				["xcrun simctl get_app_container U1 com.x.app", { stdout: "/data/App.app\n" }],
				["plutil -convert json", { stdout: JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }) }],
			],
			calls
		);
		const res = await ensureApp(input(exec, { fileSize }));
		expect(res.success && res.data.source).toBe("installed");
		expect(calls).toHaveLength(3);
		expect(calls.filter((c) => c.includes("get_app_container"))).toHaveLength(1);
		expect(calls.filter((c) => c.startsWith("plutil"))).toHaveLength(2);
		expect(calls.some((c) => c.startsWith("stat"))).toBe(false);
	});

	describe("recorded install identity (17-7)", () => {
		const plist = JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" });
		/** ino+mtime of each container's executable; `/data/App.app/App` until a test changes it */
		let stamps: Record<string, string>;
		const fileStamp = async (path: string) => stamps[path];
		let container: string;
		const device = (calls: string[]) =>
			fake(
				[
					["xcrun simctl install U1", {}],
					[
						"xcrun simctl get_app_container U1 com.x.app",
						{
							get stdout() {
								return container;
							},
						},
					],
					["plutil -convert json", { stdout: plist }],
				],
				calls
			);
		beforeEach(() => {
			stamps = { "/data/App.app/App": "11:100" };
			container = "/data/App.app";
		});

		test("install records the container and the executable's ino+mtime", async () => {
			await seedCache();
			await ensureApp(input(device([]), { fileSize, fileStamp }));
			expect(getInstall(store, "ios", "U1", "com.x.app")).toMatchObject({
				hash: "H",
				container: "/data/App.app",
				exeStamp: "11:100",
			});
		});

		test("same container, same executable: the already-installed check is one get_app_container, no plutil", async () => {
			await seedCache();
			await ensureApp(input(device([]), { fileSize, fileStamp }));
			const calls: string[] = [];
			const res = await ensureApp(input(device(calls), { fileSize, fileStamp }));
			expect(res.success && res.data.source).toBe("installed");
			expect(calls).toEqual(["xcrun simctl get_app_container U1 com.x.app"]);
		});

		test("another container (a foreign reinstall) falls back to the plutil identity check", async () => {
			await seedCache();
			await ensureApp(input(device([]), { fileSize, fileStamp }));
			container = "/data/Other/App.app";
			stamps["/data/Other/App.app/App"] = "12:200";
			const calls: string[] = [];
			const res = await ensureApp(input(device(calls), { fileSize, fileStamp }));
			expect(res.success && res.data.source).toBe("installed");
			expect(calls.filter((c) => c.startsWith("plutil"))).toHaveLength(2);
		});

		test("an executable replaced in place falls back to the plutil identity check", async () => {
			await seedCache();
			await ensureApp(input(device([]), { fileSize, fileStamp }));
			stamps["/data/App.app/App"] = "11:999";
			const calls: string[] = [];
			await ensureApp(input(device(calls), { fileSize, fileStamp }));
			expect(calls.filter((c) => c.startsWith("plutil"))).toHaveLength(2);
		});

		test("an unreadable executable records no stamp, so every check uses plutil", async () => {
			await seedCache();
			stamps = {};
			await ensureApp(input(device([]), { fileSize, fileStamp }));
			expect(getInstall(store, "ios", "U1", "com.x.app")?.exeStamp).toBeUndefined();
			const calls: string[] = [];
			await ensureApp(input(device(calls), { fileSize, fileStamp }));
			expect(calls.filter((c) => c.startsWith("plutil"))).toHaveLength(2);
		});
	});

	test("app on the device differs from the cached build → reinstall", async () => {
		const path = await seedCache();
		const exec = fake(
			[
				["xcrun simctl install U1", {}],
				["xcrun simctl get_app_container U1 com.x.app", { stdout: "/data/App.app" }],
				[
					"plutil -convert json -o - /data/App.app",
					{ stdout: JSON.stringify({ CFBundleVersion: "OLD", CFBundleExecutable: "App" }) },
				],
				["plutil -convert json", { stdout: JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }) }],
			],
			[]
		);
		await ensureApp(input(exec));
		const again = await ensureApp(input(exec));
		expect(again).toEqual({ success: true, data: { appPath: path, hash: "H", source: "cache", installed: true } });
	});

	test("installed at an old hash → reinstall", async () => {
		await seedCache("NEW");
		const calls: string[] = [];
		const exec = fake(
			[
				["xcrun simctl install U1", {}],
				["xcrun simctl get_app_container", { stdout: "/x" }],
			],
			calls
		);
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "com.x.app", hash: "OLD", installedAt: 1 });
		const res = await ensureApp(input(exec, { hash: "NEW" }));
		expect(res.success && res.data.source).toBe("cache");
		expect(calls.filter((c) => c.startsWith("xcrun simctl install"))).toHaveLength(1);
		expect(getInstall(store, "ios", "U1", "com.x.app")?.hash).toBe("NEW");
	});

	test("installMode reinstall: uninstalls then installs even though the device is already at this hash", async () => {
		await seedCache();
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "com.x.app", hash: "H", installedAt: 1 });
		const calls: string[] = [];
		let present = true;
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "xcrun simctl uninstall U1 com.x.app") present = false;
			if (joined.startsWith("xcrun simctl install U1")) present = true;
			if (joined.startsWith("xcrun simctl get_app_container")) {
				return present ? { exitCode: 0, stdout: "/x", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const res = await ensureApp(input(exec, { installMode: "reinstall" }));
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("cache");
		expect(res.data.installed).toBe(true);
		const verbs = calls.filter((c) => /simctl (un)?install/.test(c)).map((c) => c.split(" ")[2]);
		expect(verbs).toEqual(["uninstall", "install"]);
		expect(getInstall(store, "ios", "U1", "com.x.app")?.installedAt).toBe(5_000);
	});

	test("installMode clean: already at this hash → no install, the app's data is reset (keychain when asked)", async () => {
		await seedCache();
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "com.x.app", hash: "H", installedAt: 1 });
		const calls: string[] = [];
		const exec = fake(
			[
				["xcrun simctl get_app_container U1 com.x.app data", { stdout: "/data/C" }],
				["xcrun simctl get_app_container U1 com.x.app groups", { exitCode: 1 }],
				["xcrun simctl get_app_container U1 com.x.app", { stdout: "/data/App.app" }],
				["plutil -convert json", { stdout: JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }) }],
				["xcrun simctl terminate", {}],
				["xcrun simctl spawn", {}],
				["xcrun simctl privacy U1 reset all com.x.app", {}],
				["xcrun simctl keychain U1 reset", {}],
			],
			calls
		);
		const removed: string[] = [];
		const resetFs = {
			readdir: async () => ["Documents", ".com.apple.mobile_container_manager.metadata.plist"],
			rm: async (path: string) => {
				removed.push(path);
			},
			mkdir: async () => {},
		};
		const res = await ensureApp(input(exec, { installMode: "clean", resetKeychain: true, resetFs, fileSize }));
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("installed");
		expect(calls.some((c) => /simctl (un)?install/.test(c))).toBe(false);
		expect(removed).toEqual(["/data/C/Documents"]);
		expect(calls).toContain("xcrun simctl privacy U1 reset all com.x.app");
		expect(calls).toContain("xcrun simctl keychain U1 reset");
	});

	test("installMode reinstall + resetKeychain: the sim keychain is reset after the uninstall", async () => {
		await seedCache();
		const calls: string[] = [];
		let present = true;
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "xcrun simctl uninstall U1 com.x.app") present = false;
			if (joined.startsWith("xcrun simctl install U1")) present = true;
			if (joined.startsWith("xcrun simctl get_app_container")) {
				return present ? { exitCode: 0, stdout: "/x", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const res = await ensureApp(input(exec, { installMode: "reinstall", resetKeychain: true }));
		if (!res.success) throw new Error(res.error);
		const steps = calls.filter((c) => /simctl (uninstall|install|keychain)/.test(c)).map((c) => c.split(" ")[2]);
		expect(steps).toEqual(["uninstall", "keychain", "install"]);
	});

	test("legacy cache dir → imported (copied) into the warden cache", async () => {
		const legacy = join(dir, "legacy");
		fakeApp(join(legacy, "H"), "Salient.app");
		const exec = fake([], []);
		const res = await ensureApp(
			input(exec, { deviceId: undefined, project: testProject({ root: join(dir, "app"), cacheDirs: [legacy] }) })
		);
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("cache");
		expect(res.data.installed).toBe(false);
		expect(getBuild(store, KEY, "ios", "H")?.source).toBe("legacy");
	});

	test("--no-eas → local build, verified + cached with source build", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator");
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "sh -c make-ios") {
				fakeApp(products, "Built.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (joined === "sh -c fp") return { exitCode: 0, stdout: '{"hash":"H"}', stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleIdentifier")) return BUNDLE_ID;
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			build: { ios: "make-ios", android: "x" },
			eas: { profile: "development-simulator", trigger: false },
		});
		const res = await ensureApp(
			input(exec, { project, deviceId: undefined, build: true, eas: false, now: () => Date.now() })
		);
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("build");
		const record = getBuild(store, KEY, "ios", "H");
		expect(record?.source).toBe("build");
		expect(record?.profile).toBe("development-simulator");
		expect(res.data.appPath).toBe(record?.path ?? "");
		expect(calls.some((c) => c.includes("eas"))).toBe(false);
	});

	test("a local build reports building (platform + hash), then ready; no installing without a device", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator");
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === "sh -c make-ios") {
				fakeApp(products, "Built.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (joined === "sh -c fp") return { exitCode: 0, stdout: '{"hash":"H"}', stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleIdentifier")) return BUNDLE_ID;
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "make-ios", android: "x" } });
		const phases: AppPhase[] = [];
		const res = await ensureApp(
			input(exec, {
				project,
				deviceId: undefined,
				build: true,
				eas: false,
				now: () => Date.now(),
				onPhase: (p) => phases.push(p),
			})
		);
		expect(res.success).toBe(true);
		expect(phases).toEqual([{ phase: "building", platform: "ios", hash: "H" }, { phase: "ready" }]);
	});

	test("a local build stamps the native fingerprint its native dir was prebuilt for", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator");
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === "sh -c make-ios") {
				fakeApp(products, "Built.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (joined === "sh -c fp") return { exitCode: 0, stdout: '{"hash":"H"}', stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleIdentifier")) return BUNDLE_ID;
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "make-ios", android: "x" } });
		const res = await ensureApp(input(exec, { project, deviceId: undefined, build: true, now: () => Date.now() }));
		if (!res.success) throw new Error(res.error);
		expect(prebuildStamp(store, root, "ios").read()).toBe("H");
		expect(prebuildStamp(store, root, "android").read()).toBeUndefined();
	});

	test("the local build reads the git toplevel through the git cache projectContext used", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator");
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "sh -c make-ios") {
				fakeApp(products, "Built.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (joined === "sh -c fp") return { exitCode: 0, stdout: '{"hash":"H"}', stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleIdentifier")) return BUNDLE_ID;
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({ root, fingerprintCommand: "fp", build: { ios: "make-ios", android: "x" } });
		mkdirSync(join(root, "ios"), { recursive: true }); // prebuilt: no mid-build `git status` snapshot
		const git = createGitFactsCache();
		git.store(root, { toplevel: root, commonDir: join(root, ".git"), branch: "main" });
		const res = await ensureApp(
			input(exec, { project, deviceId: undefined, build: true, eas: false, now: () => Date.now(), git })
		);
		expect(res.success).toBe(true);
		expect(calls.filter((c) => c.startsWith("git"))).toEqual([]);
	});

	describe("JS-aware project (fingerprint.include native+js)", () => {
		const eas = { profile: "development-simulator", trigger: true, workflow: ".eas/wf.yml" };
		const jsProject = () => testProject({ root: join(dir, "app"), jsInputs: ["src/**"], eas });

		function gitHost(status: string, calls: string[]): Exec {
			return fake(
				[
					["git rev-parse HEAD", { stdout: "abc123\n" }],
					["git status --porcelain", { stdout: status }],
					["bunx eas-cli build:list", { stdout: "[]" }],
				],
				calls
			);
		}

		test("clean tree: EAS is looked up by git commit, never by fingerprint, never triggered", async () => {
			const calls: string[] = [];
			const res = await ensureApp(
				input(gitHost("", calls), { project: jsProject(), deviceId: undefined, build: false, eas: true })
			);
			expect(res.success).toBe(false);
			const list = calls.find((c) => c.startsWith("bunx eas-cli build:list")) ?? "";
			expect(list).toContain("--git-commit-hash abc123");
			expect(list).not.toContain("--fingerprint-hash");
			expect(calls.some((c) => c.includes("workflow:run"))).toBe(false);
		});

		test("dirty tree: EAS is skipped (its build can't match the working tree)", async () => {
			const calls: string[] = [];
			const logs: string[] = [];
			const res = await ensureApp(
				input(gitHost(" M src/a.ts\n", calls), {
					project: jsProject(),
					deviceId: undefined,
					build: false,
					eas: true,
					log: (l) => logs.push(l),
				})
			);
			expect(res.success).toBe(false);
			expect(calls.some((c) => c.startsWith("bunx eas-cli"))).toBe(false);
			expect(logs.join("\n")).toContain("working tree is not clean");
		});

		test("native projects keep the fingerprint lookup", async () => {
			const calls: string[] = [];
			await ensureApp(
				input(gitHost("", calls), {
					project: testProject({ root: join(dir, "app"), eas: { ...eas, trigger: false } }),
					deviceId: undefined,
					build: false,
					eas: true,
				})
			);
			expect(calls.find((c) => c.startsWith("bunx eas-cli build:list"))).toContain("--fingerprint-hash H");
		});

		test("a native-only Release key still looks EAS up by the native fingerprint", async () => {
			const calls: string[] = [];
			await ensureApp(
				input(gitHost("", calls), {
					project: testProject({
						root: join(dir, "app"),
						buildConfiguration: "Release",
						eas: { ...eas, trigger: false },
					}),
					hash: "SALTED",
					native: "N1",
					deviceId: undefined,
					build: false,
					eas: true,
				})
			);
			expect(calls.find((c) => c.startsWith("bunx eas-cli build:list"))).toContain("--fingerprint-hash N1");
		});
	});

	test("a variant build is cached under <profile>:<variant>; build.cache false reaches the local build", async () => {
		const root = join(dir, "app");
		const products = join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator");
		const calls: string[] = [];
		const envs: Array<Record<string, string | undefined> | undefined> = [];
		const exec: Exec = async (cmd, opts) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "sh -c make-ios") {
				envs.push(opts?.env);
				fakeApp(products, "Built.app");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (joined === "sh -c fp") return { exitCode: 0, stdout: '{"hash":"H"}', stderr: "" };
			if (joined.startsWith("plutil -extract CFBundleIdentifier")) return BUNDLE_ID;
			return { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			build: { ios: "make-ios", android: "x" },
			variant: "dev",
			compilerCache: false,
		});
		const res = await ensureApp(
			input(exec, { project, deviceId: undefined, build: true, eas: false, now: () => Date.now() })
		);
		if (!res.success) throw new Error(res.error);
		expect(getBuild(store, KEY, "ios", "H")?.profile).toBe("local:dev");
		expect(envs[0]?.USE_CCACHE).toBeUndefined();
		expect(calls.some((c) => c.startsWith("xcodebuild"))).toBe(false);
	});

	test("missing bundle id for a device install → error", async () => {
		await seedCache();
		const res = await ensureApp(
			input(fake([], []), { project: testProject({ root: join(dir, "app"), bundleId: { android: "a" } }) })
		);
		expect(res.success).toBe(false);
	});
});

describe("projectContext", () => {
	test("loads the config bounded by the git toplevel and keys by remote", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps", "a"), { recursive: true });
		writeFileSync(
			join(repo, JSON_CONFIG_FILE),
			JSON.stringify({ projects: [{ name: "a", root: "apps/a", bundleId: { ios: "com.a" } }] })
		);
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD") {
				return { exitCode: 0, stdout: `${repo}\n${repo}/.git\nrefs/heads/main\n`, stderr: "" };
			}
			if (joined === "git config --get remote.origin.url")
				return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: join(repo, "apps", "a") });
		if (!res.success) throw new Error(res.error);
		expect(res.data.projectKey).toBe("github.com/o/r:apps/a");
		expect(res.data.project.name).toBe("a");
		const dev = await projectContext({ exec, env, start: join(repo, "apps", "a"), variant: "dev" });
		expect(dev.success).toBe(false);
		const optional = await projectContext({
			exec,
			env,
			start: join(repo, "apps", "a"),
			variant: "dev",
			variantOptional: true,
		});
		expect(optional.success).toBe(true);
	});

	test("project + key cost two git spawns (one rev-parse, the remote), shared through the git cache", async () => {
		const repo = join(realpathSync(dir), "repo2");
		mkdirSync(join(repo, "apps", "a"), { recursive: true });
		writeFileSync(
			join(repo, JSON_CONFIG_FILE),
			JSON.stringify({ projects: [{ name: "a", root: ".", bundleId: { ios: "com.a" } }] })
		);
		const spawns: string[] = [];
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			spawns.push(joined);
			if (joined === "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD") {
				return { exitCode: 0, stdout: `${repo}\n${repo}/.git\nrefs/heads/main\n`, stderr: "" };
			}
			if (joined === "git config --get remote.origin.url")
				return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: repo, git: createGitFactsCache() });
		expect(res.success).toBe(true);
		expect(spawns).toEqual([
			"git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD",
			"git config --get remote.origin.url",
		]);
	});
});

describe("ensureApp: one build per session", () => {
	const root = () => join(dir, "app");
	const products = () => join(root(), "ios", "build", "Build", "Products", "Debug-iphonesimulator");

	/**
	 * iOS host: `make-ios` builds (or fails), `fp` prints `before` until the first build ran, `fingerprint` after it
	 * (a prebuild re-key); `during` runs inside the build with its line sink. Installs and probes succeed on any sim.
	 */
	function host(opts: {
		fingerprint: string;
		before?: string;
		fail?: boolean;
		during?: (onLine: (line: string) => void) => Promise<void>;
	}) {
		const calls: string[] = [];
		let built = false;
		const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
		const handlers: Array<[string, () => ExecResult]> = [
			["sh -c fp", () => ok(`{"hash":"${built ? opts.fingerprint : (opts.before ?? opts.fingerprint)}"}`)],
			["git status --porcelain", () => ok()],
			["plutil -extract CFBundleIdentifier", () => BUNDLE_ID],
			["plutil -convert json", () => ok(JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }))],
			["xcrun simctl install", () => ok()],
			["xcrun simctl get_app_container", () => ok("/data/App.app\n")],
		];
		const exec: Exec = async (cmd, execOpts) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "sh -c make-ios") {
				await opts.during?.((line) => execOpts?.onLine?.(line));
				if (opts.fail) return { exitCode: 65, stdout: "", stderr: "BUILD FAILED" };
				fakeApp(products(), "Built.app");
				built = true;
				return ok();
			}
			const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
			return hit ? hit[1]() : { exitCode: 127, stdout: "", stderr: joined };
		};
		const project = testProject({ root: root(), fingerprintCommand: "fp", build: { ios: "make-ios", android: "x" } });
		return { calls, exec, project };
	}
	const builds = (calls: string[]) => calls.filter((c) => c === "sh -c make-ios").length;

	test("a fresh checkout's prebuild re-key: cached under the requested key, aliased under the post-build key (17-1)", async () => {
		const s = host({ before: "H", fingerprint: "H2" });
		const over = { project: s.project, build: true, now: () => Date.now(), fileSize };
		const first = await ensureApp(input(s.exec, { ...over, deviceId: "U1" }));
		if (!first.success) throw new Error(first.error);
		expect(first.data).toMatchObject({ hash: "H", source: "build", installed: true });
		const requested = cachedBuild(store, KEY, "ios", "H", Date.now());
		const alias = cachedBuild(store, KEY, "ios", "H2", Date.now());
		expect(requested?.path).toBe(first.data.appPath);
		expect(alias?.path).toBe(first.data.appPath);
		expect(alias?.size).toBe(0);
		expect(getInstall(store, "ios", "U1", "com.x.app")?.hash).toBe("H2");

		// device 2 of the same session (pre-build key): the cache, no second build
		const second = await ensureApp(input(s.exec, { ...over, deviceId: "U2" }));
		expect(second.success && second.data.source).toBe("cache");
		expect(builds(s.calls)).toBe(1);

		// the next run in this worktree computes the post-build key: both devices are already there
		for (const deviceId of ["U1", "U2"]) {
			const again = await ensureApp(input(s.exec, { ...over, hash: "H2", deviceId }));
			expect(again.success && again.data.source).toBe("installed");
		}
		expect(builds(s.calls)).toBe(1);
	});

	test("the alias never replaces a real build of the post-build key", async () => {
		const real = await seedCache("H2");
		const s = host({ before: "H", fingerprint: "H2" });
		const res = await ensureApp(
			input(s.exec, { project: s.project, build: true, deviceId: undefined, now: () => Date.now() })
		);
		expect(res.success).toBe(true);
		expect(getBuild(store, KEY, "ios", "H2")?.path).toBe(real);
	});

	test("two devices on a failing cache miss: one build, two errors, no lock poll (17-4)", async () => {
		const s = host({ fingerprint: "H", fail: true });
		let sleeps = 0;
		const over = { project: s.project, build: true, sleep: async () => void sleeps++ };
		const [a, b] = await Promise.all([
			ensureApp(input(s.exec, { ...over, deviceId: "U1" })),
			ensureApp(input(s.exec, { ...over, deviceId: "U2" })),
		]);
		expect(a.success).toBe(false);
		expect(b.success).toBe(false);
		if (!a.success && !b.success) expect(b.error).toBe(a.error);
		expect(builds(s.calls)).toBe(1);
		expect(sleeps).toBe(0);
	});

	test("two devices on a successful cache miss: one build, both installed, no lock poll (17-4)", async () => {
		const s = host({ fingerprint: "H" });
		let sleeps = 0;
		const sleep = async (ms: number) => {
			sleeps++;
			await Bun.sleep(Math.min(ms, 5));
		};
		const over = { project: s.project, build: true, now: () => Date.now(), sleep };
		const [a, b] = await Promise.all([
			ensureApp(input(s.exec, { ...over, deviceId: "U1" })),
			ensureApp(input(s.exec, { ...over, deviceId: "U2" })),
		]);
		expect(a.success && a.data.installed).toBe(true);
		expect(b.success && b.data.installed).toBe(true);
		expect(builds(s.calls)).toBe(1);
		expect(sleeps).toBe(0);
		expect(s.calls.filter((c) => c.startsWith("xcrun simctl install"))).toHaveLength(2);
	});
});

describe("ensureApp: one build per checkout (two processes)", () => {
	const root = () => join(dir, "app");
	const products = () => join(root(), "ios", "build", "Build", "Products", "Debug-iphonesimulator");
	const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

	/** A shared fake checkout: `fp` reads `tree.fp`, `make-ios` runs `during` then prebuilds (fp → `after`) and builds. */
	function checkout(tree: { fp: string; after: string }, during: (onLine: (line: string) => void) => Promise<void>) {
		const calls: string[] = [];
		const answers: Array<[string, () => ExecResult]> = [
			["sh -c fp", () => ok(`{"hash":"${tree.fp}"}`)],
			["git status --porcelain", () => ok()],
			["plutil -extract CFBundleIdentifier", () => BUNDLE_ID],
			["plutil -convert json", () => ok(JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" }))],
			["xcrun simctl", () => ok("/data/App.app\n")],
		];
		const exec: Exec = async (cmd, execOpts) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined !== "sh -c make-ios") {
				const hit = answers.find(([prefix]) => joined.startsWith(prefix));
				return hit ? hit[1]() : { exitCode: 127, stdout: "", stderr: joined };
			}
			await during((line) => execOpts?.onLine?.(line));
			fakeApp(products(), "Built.app");
			tree.fp = tree.after;
			return ok();
		};
		const project = testProject({ root: root(), fingerprintCommand: "fp", build: { ios: "make-ios", android: "x" } });
		return { calls, exec, project };
	}

	test("B fingerprinted mid-prebuild: waits on the checkout, mirrors A's build log, installs A's build (one build)", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let started = () => {};
		const building = new Promise<void>((r) => {
			started = r;
		});
		const tree = { fp: "H", after: "H2" };
		const s = checkout(tree, async (onLine) => {
			onLine("compiling A");
			started();
			await gate;
			onLine("linking A");
		});
		const aLines: string[] = [];
		const bLines: string[] = [];
		const bPhases: AppPhase[] = [];
		const base = { project: s.project, build: true, now: () => Date.now(), fileSize };
		const a = ensureApp(
			input(s.exec, {
				...base,
				owner: { kind: "agent", sessionId: "a", cwd: dir },
				pid: 11,
				buildOutput: (l) => aLines.push(l),
			})
		);
		await building;
		// B's fingerprint read the half-written ios/: neither A's key nor the post-prebuild key
		const b = ensureApp(
			input(s.exec, {
				...base,
				hash: "Hmid",
				deviceId: "U2",
				owner: { kind: "agent", sessionId: "b", cwd: dir },
				pid: 22,
				buildOutput: (l) => bLines.push(l),
				onPhase: (p) => bPhases.push(p),
				sleep: async () => {
					await Bun.sleep(2);
					if (bLines.includes("compiling A")) release();
				},
			})
		);
		const [ra, rb] = await Promise.all([a, b]);
		if (!ra.success) throw new Error(ra.error);
		if (!rb.success) throw new Error(rb.error);
		expect(s.calls.filter((c) => c === "sh -c make-ios")).toHaveLength(1);
		expect(ra.data.source).toBe("build");
		expect(rb.data).toMatchObject({ source: "cache", installed: true, appPath: ra.data.appPath });
		expect(getInstall(store, "ios", "U2", "com.x.app")?.hash).toBe("H2");
		expect(aLines).toEqual(["compiling A", "linking A"]);
		expect(bLines).toEqual(["compiling A", "linking A"]);
		expect(bPhases[0]).toEqual({ phase: "waiting" });
		expect(bPhases.some((p) => p.phase === "building")).toBe(false);
		expect(store.listLeases()).toEqual([]);
	});

	test("the checkout moved under the lock and nothing is cached for it → a clear error, no second build", async () => {
		const tree = { fp: "H", after: "H" };
		const s = checkout(tree, async () => {});
		tree.fp = "Hedit";
		const res = await ensureApp(input(s.exec, { project: s.project, build: true, now: () => Date.now(), fileSize }));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("changed since it was fingerprinted (H → Hedit)");
		expect(s.calls).not.toContain("sh -c make-ios");
	});
});

describe("projectContext with a dynamic app.config.*", () => {
	const gitAnswers = (repo: string, cmd: readonly string[]): ExecResult | undefined => {
		const joined = cmd.join(" ");
		if (joined === "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD")
			return { exitCode: 0, stdout: `${repo}\n${repo}/.git\nrefs/heads/main\n`, stderr: "" };
		if (joined === "git config --get remote.origin.url")
			return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
		return undefined;
	};
	const expoConfig = {
		slug: "ctna-wallet",
		name: "CTNA Wallet",
		scheme: "ctnawallet",
		ios: { bundleIdentifier: "com.x.dev" },
	};

	test("reads the bundle id, slug and scheme through `expo config` when nothing else supplies them", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps", "mobile"), { recursive: true });
		writeFileSync(join(repo, "apps", "mobile", "app.config.ts"), "export default { ios: { bundleIdentifier: 'x' } }");
		const calls: Array<{ cmd: string; cwd: string | undefined }> = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: cmd.join(" "), cwd: opts?.cwd });
			if (cmd.join(" ") === EXPO_CONFIG_ARGV.join(" "))
				return { exitCode: 0, stdout: JSON.stringify(expoConfig), stderr: "" };
			return gitAnswers(repo, cmd) ?? { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: join(repo, "apps", "mobile") });
		if (!res.success) throw new Error(res.error);
		expect(res.data.project.bundleId).toEqual({ ios: "com.x.dev" });
		expect(res.data.project.name).toBe("ctna-wallet");
		expect(res.data.project.origin).toBe("app.config");
		expect(res.data.appConfig).toEqual({ slug: "ctna-wallet", scheme: "ctnawallet" });
		expect(calls.find((c) => c.cmd.startsWith("bunx expo config"))?.cwd).toBe(join(repo, "apps", "mobile"));
	});

	test("from a monorepo root, the one app below it is resolved through `expo config` in its own dir", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps", "mobile"), { recursive: true });
		mkdirSync(join(repo, "apps", "api"), { recursive: true });
		writeFileSync(join(repo, "package.json"), JSON.stringify({ workspaces: ["apps/api", "apps/mobile"] }));
		writeFileSync(join(repo, "apps", "api", "package.json"), JSON.stringify({ name: "api" }));
		writeFileSync(join(repo, "apps", "mobile", "app.config.ts"), "export default {}");
		const calls: Array<{ cmd: string; cwd: string | undefined }> = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: cmd.join(" "), cwd: opts?.cwd });
			if (cmd.join(" ") === EXPO_CONFIG_ARGV.join(" "))
				return { exitCode: 0, stdout: JSON.stringify(expoConfig), stderr: "" };
			return gitAnswers(repo, cmd) ?? { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: repo });
		if (!res.success) throw new Error(res.error);
		expect(res.data.project.root).toBe(join(repo, "apps", "mobile"));
		expect(res.data.project.bundleId).toEqual({ ios: "com.x.dev" });
		expect(calls.find((c) => c.cmd.startsWith("bunx expo config"))?.cwd).toBe(join(repo, "apps", "mobile"));
	});

	test("a failing `expo config` keeps the original error and adds expo's", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps", "mobile"), { recursive: true });
		writeFileSync(join(repo, "apps", "mobile", "app.config.ts"), "export default {}");
		const exec: Exec = async (cmd) => {
			if (cmd.join(" ") === EXPO_CONFIG_ARGV.join(" "))
				return { exitCode: 1, stdout: "", stderr: "Cannot find module 'expo/config'" };
			return gitAnswers(repo, cmd) ?? { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: join(repo, "apps", "mobile") });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error).toContain("--bundle-id");
			expect(res.error).toContain("Cannot find module 'expo/config'");
		}
	});

	test("never runs `expo config` when --bundle-id or a warden config supplies the id", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps", "mobile"), { recursive: true });
		writeFileSync(join(repo, "apps", "mobile", "app.config.ts"), "export default {}");
		const spawned: string[] = [];
		const exec: Exec = async (cmd) => {
			spawned.push(cmd.join(" "));
			return gitAnswers(repo, cmd) ?? { exitCode: 1, stdout: "", stderr: "" };
		};
		const flagged = await projectContext({
			exec,
			env,
			start: join(repo, "apps", "mobile"),
			bundleId: { ios: "com.f" },
		});
		expect(flagged.success).toBe(true);
		writeFileSync(
			join(repo, JSON_CONFIG_FILE),
			JSON.stringify({ projects: [{ name: "m", root: "apps/mobile", bundleId: { ios: "com.c" } }] })
		);
		const configured = await projectContext({ exec, env, start: join(repo, "apps", "mobile") });
		expect(configured.success).toBe(true);
		expect(spawned.some((c) => c.startsWith("bunx expo config"))).toBe(false);
	});
});

describe("ensureKindBuild", () => {
	const FP = "fp-native";
	const plist = JSON.stringify({ CFBundleVersion: "1", CFBundleExecutable: "App" });

	function kindInput(exec: Exec, over: Partial<EnsureKindInput> = {}): EnsureKindInput {
		const { hash: _hash, project: _project, ...rest } = input(exec, { fileSize });
		return {
			...rest,
			project: testProject({ root: join(dir, "app"), fingerprintCommand: "fp" }),
			key: { kind: "dev", nativeFp: FP },
			buildKey: FP,
			...over,
		};
	}

	/** the fake host's answers by command prefix; any other `sh -c <build>` runs `build` */
	const answers: Array<[string, ExecResult]> = [
		["sh -c fp", { exitCode: 0, stdout: `{"hash":"${FP}"}`, stderr: "" }],
		["plutil -extract CFBundleIdentifier", BUNDLE_ID],
		["plutil -convert json", { exitCode: 0, stdout: plist, stderr: "" }],
		["xcrun simctl get_app_container", { exitCode: 0, stdout: "/data/App.app", stderr: "" }],
		["xcrun simctl install", { exitCode: 0, stdout: "", stderr: "" }],
	];

	const fpExec =
		(calls: string[], build?: () => void): Exec =>
		async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			const known = answers.find(([prefix]) => joined.startsWith(prefix));
			if (known) return known[1];
			if (!joined.startsWith("sh -c ")) return { exitCode: 127, stdout: "", stderr: joined };
			build?.();
			return { exitCode: 0, stdout: "", stderr: "" };
		};

	async function seedKind(key: { kind: "dev" | "simulator-base"; nativeFp: string }, layoutDir: string) {
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local",
			hash: kindHash(key),
			artifact: fakeApp(join(dir, "seed")),
			source: "import",
			layout: { dir: layoutDir, kind: key.kind },
			now: 1,
		});
		if (!res.success) throw new Error(res.error);
		return res.data.path;
	}

	test("a cached dev build is found by its kind hash and installed; the install record keys by it", async () => {
		const path = await seedKind({ kind: "dev", nativeFp: FP }, devDir(env, KEY, "ios", FP));
		const res = await ensureKindBuild(kindInput(fpExec([])));
		expect(res).toEqual({
			success: true,
			data: { appPath: path, hash: `${FP}:dev`, source: "cache", installed: true },
		});
		expect(getInstall(store, "ios", "U1", "com.x.app")?.hash).toBe(`${FP}:dev`);
	});

	test("a flat legacy build of the same fingerprint is not the dev build", async () => {
		await seedCache(FP);
		const calls: string[] = [];
		const res = await ensureKindBuild(kindInput(fpExec(calls), { deviceId: undefined }));
		expect(res.success).toBe(false);
		expect(calls.some((c) => c.startsWith("sh -c"))).toBe(false);
	});

	test("a miss builds with the kind's command, verifies the build key and caches into the kind dir", async () => {
		const root = join(dir, "app");
		const calls: string[] = [];
		const exec = fpExec(calls, () => {
			fakeApp(join(root, "ios", "build", "Build", "Products", "Debug-iphonesimulator"), "Built.app");
		});
		const res = await ensureKindBuild(kindInput(exec, { deviceId: undefined, build: true, now: () => Date.now() }));
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("build");
		const record = getBuild(store, KEY, "ios", `${FP}:dev`);
		expect(record).toMatchObject({
			kind: "dev",
			path: join(devDir(env, KEY, "ios", FP), "Built.app"),
			profile: "local:dev",
		});
		expect(calls.some((c) => c.includes("expo run:ios") && !c.includes("--configuration Release"))).toBe(true);
	});

	test("the simulator base builds the Release configuration with SKIP_BUNDLING into simulator/base", async () => {
		const root = join(dir, "app");
		const project = testProject({ root, fingerprintCommand: "fp" });
		const buildKeyOf = await computeCacheKey(
			fpExec([]),
			projectForKind(project, "simulator"),
			"ios",
			undefined,
			undefined,
			{}
		);
		if (!buildKeyOf.success) throw new Error(buildKeyOf.error);
		const nativeFp = buildKeyOf.data.key;
		const calls: string[] = [];
		const exec = fpExec(calls, () => {
			fakeApp(join(root, "ios", "build", "Build", "Products", "Release-iphonesimulator"), "Built.app");
		});
		const res = await ensureKindBuild(
			kindInput(exec, {
				project,
				key: { kind: "simulator-base", nativeFp },
				buildKey: nativeFp,
				deviceId: undefined,
				build: true,
				now: () => Date.now(),
			})
		);
		if (!res.success) throw new Error(res.error);
		expect(calls.some((c) => c.includes("SKIP_BUNDLING=1") && c.includes("--configuration Release"))).toBe(true);
		expect(getBuild(store, KEY, "ios", `${nativeFp}:base`)).toMatchObject({
			kind: "simulator-base",
			path: join(simulatorBaseDir(env, KEY, "ios", nativeFp), "Built.app"),
		});
	});

	test("EAS never supplies the simulator base", async () => {
		const calls: string[] = [];
		const project = testProject({
			root: join(dir, "app"),
			fingerprintCommand: "fp",
			eas: { profile: "p", trigger: false },
		});
		await ensureKindBuild(
			kindInput(fpExec(calls), {
				project,
				key: { kind: "simulator-base", nativeFp: FP },
				deviceId: undefined,
				eas: true,
				build: false,
			})
		);
		expect(calls.some((c) => c.includes("eas-cli"))).toBe(false);
	});

	test("EAS still serves a dev build", async () => {
		const calls: string[] = [];
		const project = testProject({
			root: join(dir, "app"),
			fingerprintCommand: "fp",
			eas: { profile: "p", trigger: false },
		});
		await ensureKindBuild(kindInput(fpExec(calls), { project, deviceId: undefined, eas: true, build: false }));
		expect(calls.some((c) => c.includes("eas-cli build:list"))).toBe(true);
	});
});
