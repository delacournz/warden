import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import { fakeApp, testProject } from "./builds.testing";
import { getBuild, getInstall, recordInstall, storeArtifact } from "./cache";
import { CONFIG_FILE } from "./config";
import { type EnsureInput, ensureApp, projectContext } from "./ensure";

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
			],
			calls
		);
		const first = await ensureApp(input(exec));
		expect(first).toEqual({ success: true, data: { appPath: path, hash: "H", source: "cache", installed: true } });
		expect(getInstall(store, "ios", "U1", "com.x.app")?.hash).toBe("H");
		expect(getBuild(store, KEY, "ios", "H")?.lastUsedAt).toBe(5_000);

		calls.length = 0;
		const second = await ensureApp(input(exec));
		expect(second).toEqual({ success: true, data: { appPath: path, hash: "H", source: "installed", installed: true } });
		expect(calls).toEqual(["xcrun simctl get_app_container U1 com.x.app"]);
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

	test("clean: uninstalls then installs even though the device is already at this hash", async () => {
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
		const res = await ensureApp(input(exec, { clean: true }));
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("cache");
		expect(res.data.installed).toBe(true);
		const verbs = calls.filter((c) => /simctl (un)?install/.test(c)).map((c) => c.split(" ")[2]);
		expect(verbs).toEqual(["uninstall", "install"]);
		expect(getInstall(store, "ios", "U1", "com.x.app")?.installedAt).toBe(5_000);
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
			join(repo, CONFIG_FILE),
			JSON.stringify({ projects: [{ name: "a", root: "apps/a", bundleId: { ios: "com.a" } }] })
		);
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: `${repo}\n`, stderr: "" };
			if (joined === "git config --get remote.origin.url")
				return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		const res = await projectContext({ exec, env, start: join(repo, "apps", "a") });
		if (!res.success) throw new Error(res.error);
		expect(res.data.projectKey).toBe("github.com/o/r:apps/a");
		expect(res.data.project.name).toBe("a");
	});
});
