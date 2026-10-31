import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { openStore, type Store } from "../store";
import { testProject } from "./builds.testing";
import {
	ensureKindApp,
	type KindAppDeps,
	type KindAppInput,
	kindWarnings,
	prepareKindApp,
	projectRepackers,
} from "./ensure-kind";
import type { KindKeys } from "./kind-key";
import type { RepackResult } from "./repack";
import { applyAndroidRepack } from "./repack-android";
import type { EnsureResult } from "./resolve";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ensure-kind-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const exec: Exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });

function input(kind: KindAppInput["kind"], over: Partial<KindAppInput> = {}): { input: KindAppInput; logs: string[] } {
	const logs: string[] = [];
	return {
		logs,
		input: {
			kind,
			store,
			exec,
			env: {},
			now: () => 1,
			sleep: async () => {},
			log: (line) => logs.push(line),
			pidAlive: () => true,
			owner: { kind: "agent", sessionId: "s", cwd: "/" },
			pid: 1,
			platform: "ios",
			project: testProject(),
			projectKey: "k",
			eas: false,
			build: true,
			repackers: {
				ios: async () => err("unused"),
				android: async () => err("unused"),
			},
			...over,
		},
	};
}

const keys = (kind: "dev" | "release"): KindKeys => ({
	key: kind === "dev" ? { kind: "dev", nativeFp: "fp" } : { kind: "release", nativeFp: "fp", jsKey: "js" },
	buildKey: "bk",
	native: "n",
	project: testProject(),
	settings: {
		kind,
		build: { ios: "", android: "" },
		buildConfiguration: "Debug",
		embedsJs: false,
		fingerprint: "native",
		env: {},
	},
});

type Calls = {
	repack: number;
	builds: string[];
	installs: { hash: string; deviceId: string | undefined; build: boolean }[];
};

function deps(repack: RepackResult, calls: Calls): KindAppDeps {
	return {
		repack: async () => {
			calls.repack++;
			return ok(repack);
		},
		computeKeys: async (d) => ok(keys(d.kind === "dev" ? "dev" : "release")),
		ensureBuild: async (i) => {
			calls.builds.push(i.key.kind);
			const result: EnsureResult = {
				appPath: `/cache/${i.key.kind}/App.app`,
				hash: `fp:${i.key.kind}`,
				source: "build",
				installed: false,
			};
			return ok(result);
		},
		ensureApp: async (i) => {
			calls.installs.push({ hash: i.hash, deviceId: i.deviceId, build: i.build });
			return ok({ appPath: "/x", hash: i.hash, source: "cache", installed: true });
		},
	};
}

const calls = (): Calls => ({ repack: 0, builds: [], installs: [] });
const repacked: RepackResult = {
	kind: "repacked",
	artifact: "/cache/repack/App.app",
	hash: "fp:js",
	baseHash: "fp:base",
	jsKey: "js",
	bundleMs: 1200,
};

describe("prepareKindApp", () => {
	test("simulator repacks once and reports the jsKey", async () => {
		const c = calls();
		const run = input("simulator");
		const res = await prepareKindApp(run.input, deps(repacked, c));
		expect(res).toEqual({
			success: true,
			data: {
				kind: "simulator",
				requested: "simulator",
				artifact: "/cache/repack/App.app",
				hash: "fp:js",
				source: "repack",
				installed: false,
				repack: { jsKey: "js", baseHash: "fp:base", reused: false, bundleMs: 1200 },
			},
		});
		expect(c.repack).toBe(1);
		expect(c.builds).toEqual([]);
	});

	test("a reused repack is reported as reused", async () => {
		const res = await prepareKindApp(input("simulator").input, deps({ ...repacked, kind: "reused" }, calls()));
		expect(res.success && res.data.kind === "simulator" && res.data.repack.reused).toBe(true);
	});

	test("fallback builds the release kind and says why", async () => {
		const c = calls();
		const run = input("simulator");
		const res = await prepareKindApp(run.input, deps({ kind: "fallback", reason: "images changed" }, c));
		expect(res).toEqual({
			success: true,
			data: {
				kind: "release",
				requested: "simulator",
				artifact: "/cache/release/App.app",
				hash: "fp:release",
				source: "build",
				installed: false,
				fallbackReason: "images changed",
			},
		});
		expect(c.builds).toEqual(["release"]);
		expect(run.logs.join("\n")).toContain("images changed");
	});

	test("dev builds the dev kind without repacking", async () => {
		const c = calls();
		const res = await prepareKindApp(input("dev").input, deps(repacked, c));
		expect(res.success && res.data.kind).toBe("dev");
		expect(c.repack).toBe(0);
		expect(c.builds).toEqual(["dev"]);
	});

	test("a repack error is returned as is", async () => {
		const failing: KindAppDeps = { ...deps(repacked, calls()), repack: async () => err("repack: boom") };
		expect(await prepareKindApp(input("simulator").input, failing)).toEqual({ success: false, error: "repack: boom" });
	});
});

describe("a physical iPhone", () => {
	const TEAM = "ABCDE12345";
	const phone = (kind: KindAppInput["kind"], over: Partial<KindAppInput> = {}) =>
		input(kind, { physical: true, env: { WARDEN_IOS_TEAM_ID: TEAM }, ...over });

	test("release is keyed and built for the device, signed by the env team", async () => {
		const c = calls();
		const seen: unknown[] = [];
		const d = deps(repacked, c);
		d.computeKeys = async (k) => {
			seen.push(k.device);
			return ok(keys("release"));
		};
		const res = await prepareKindApp(phone("release").input, d);
		expect(seen).toEqual([{ team: TEAM, salt: TEAM }]);
		expect(res.success && res.data.device).toEqual({ team: TEAM, salt: TEAM });
		expect(c.repack).toBe(0);
	});

	test("the config team is used when the env names none; an ambiguous keychain stops with the way out", async () => {
		const seen: unknown[] = [];
		const d = deps(repacked, calls());
		d.computeKeys = async (k) => {
			seen.push(k.device?.team);
			return ok(keys("dev"));
		};
		await prepareKindApp(phone("dev", { env: {}, configTeamId: "ZZZZZ99999" }).input, d);
		expect(seen).toEqual(["ZZZZZ99999"]);
		const two = [
			'  1) 1111111111111111111111111111111111111111 "Apple Development: A (AAAAAAAAAA)"',
			'  2) 2222222222222222222222222222222222222222 "Apple Development: B (BBBBBBBBBB)"',
		].join("\n");
		const keychain: Exec = async (cmd) =>
			cmd[1] === "find-identity" ? { exitCode: 0, stdout: two, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
		const res = await prepareKindApp(phone("release", { env: {}, exec: keychain }).input, deps(repacked, calls()));
		expect(!res.success && res.error).toContain("WARDEN_IOS_TEAM_ID");
	});

	test("the simulator kind is refused: nothing is repacked or built", async () => {
		const c = calls();
		const res = await prepareKindApp(phone("simulator").input, deps(repacked, c));
		expect(!res.success && res.error).toContain("simulator kind is not supported on a physical iPhone");
		expect(c.repack + c.builds.length).toBe(0);
	});

	test("an Android phone keeps the host-built kinds", async () => {
		const c = calls();
		const res = await prepareKindApp(phone("simulator", { platform: "android" }).input, deps(repacked, c));
		expect(res.success && res.data.kind).toBe("simulator");
		expect(c.repack).toBe(1);
	});

	test("the install uses the device bundle id and the physical flag", async () => {
		const seen: Array<{ ios: string | undefined; physical: boolean | undefined }> = [];
		const d = deps(repacked, calls());
		d.ensureApp = async (i) => {
			seen.push({ ios: i.project.bundleId.ios, physical: i.physical });
			return ok({ appPath: "/x", hash: i.hash, source: "cache", installed: true });
		};
		const project = testProject({ iosDeviceBundleId: "com.me.app" });
		const res = await ensureKindApp(phone("release", { project, deviceId: "UDID" }).input, d);
		expect(res.success && res.data.installed).toBe(true);
		expect(seen).toEqual([{ ios: "com.me.app", physical: true }]);
	});
});

describe("a phone the provisioning profile does not list", () => {
	const TEAM = "ABCDE12345";
	const UDID = "00008140-000A0B0C0D0E0F10";
	const NOT_IN_PROFILE =
		"devicectl install app failed: device_not_in_profile: the app's provisioning profile does not list this phone";

	/** the first install of each run answers `first`, the next ones succeed */
	function flow(first: string[]) {
		const c = calls();
		const queue = [...first];
		const d = deps(repacked, c);
		d.ensureApp = async (i) => {
			c.installs.push({ hash: i.hash, deviceId: i.deviceId, build: i.build });
			const failure = queue.shift();
			return failure === undefined
				? ok({ appPath: "/x", hash: i.hash, source: "cache", installed: true })
				: err(failure);
		};
		const commands: string[] = [];
		const run = input("release", {
			physical: true,
			deviceId: UDID,
			env: { WARDEN_IOS_TEAM_ID: TEAM, WARDEN_HOME: dir },
			exec: async (cmd) => {
				commands.push(cmd.join(" "));
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		return { c, d, commands, run };
	}

	test("registers the phone with a build for its destination, rebuilds and installs once more", async () => {
		const { c, d, commands, run } = flow([NOT_IN_PROFILE]);
		const res = await ensureKindApp(run.input, d);
		expect(res.success && res.data.installed).toBe(true);
		const registering = commands.filter((cmd) => cmd.includes("xcodebuild"));
		expect(registering).toHaveLength(1);
		expect(registering[0]).toContain(`-destination id=${UDID}`);
		expect(registering[0]).not.toContain("generic/platform=iOS");
		expect(registering[0]).toContain("-allowProvisioningUpdates");
		expect(c.builds).toEqual(["release", "release"]);
		expect(c.installs).toHaveLength(2);
		expect(run.logs.join("\n")).toContain(UDID);
	});

	test("a phone registered before is not registered again: the install error stands", async () => {
		const { c, d, commands, run } = flow([NOT_IN_PROFILE]);
		const first = await ensureKindApp(run.input, d);
		expect(first.success).toBe(true);
		const again = flow([NOT_IN_PROFILE]);
		const second = await ensureKindApp(again.run.input, again.d);
		expect(!second.success && second.error).toContain("device_not_in_profile");
		expect(again.commands.filter((cmd) => cmd.includes("xcodebuild"))).toHaveLength(0);
		expect(commands.filter((cmd) => cmd.includes("xcodebuild"))).toHaveLength(1);
		expect(c.installs).toHaveLength(2);
	});

	test("the registration build failing reports why, with the original code", async () => {
		const { d, run } = flow([NOT_IN_PROFILE]);
		run.input.exec = async () => ({ exitCode: 65, stdout: "", stderr: "error: No account for team" });
		const res = await ensureKindApp(run.input, d);
		expect(!res.success && res.error).toContain("device_not_in_profile");
		expect(!res.success && res.error).toContain("No account for team");
	});

	test("any other install failure is not retried", async () => {
		const { c, d, commands, run } = flow(["devicectl install app failed: device_locked: unlock"]);
		const res = await ensureKindApp(run.input, d);
		expect(!res.success && res.error).toContain("device_locked");
		expect(commands).toEqual([]);
		expect(c.installs).toHaveLength(1);
	});
});

describe("ensureKindApp", () => {
	test("without a device nothing is installed", async () => {
		const c = calls();
		const res = await ensureKindApp(input("simulator").input, deps(repacked, c));
		expect(res.success && res.data.installed).toBe(false);
		expect(c.installs).toEqual([]);
	});

	test("with a device the repack is installed by its hash, never rebuilt", async () => {
		const c = calls();
		const res = await ensureKindApp(input("simulator", { deviceId: "UDID" }).input, deps(repacked, c));
		expect(res.success && res.data.installed).toBe(true);
		expect(c.installs).toEqual([{ hash: "fp:js", deviceId: "UDID", build: false }]);
	});

	test("a device that already runs the build reports source installed", async () => {
		const c = calls();
		const d = deps(repacked, c);
		d.ensureApp = async (i) => ok({ appPath: "", hash: i.hash, source: "installed", installed: true });
		const res = await ensureKindApp(input("simulator", { deviceId: "UDID" }).input, d);
		expect(res.success && res.data.source).toBe("installed");
	});

	test("a fallback installs the release build", async () => {
		const c = calls();
		const res = await ensureKindApp(
			input("simulator", { deviceId: "UDID" }).input,
			deps({ kind: "fallback", reason: "r" }, c)
		);
		expect(res.success && res.data.kind).toBe("release");
		expect(c.installs[0]?.hash).toBe("fp:release");
	});
});

describe("kindWarnings", () => {
	const aware = testProject({ jsInputs: ["src/**"] });

	test("a JS-aware project warns for dev and simulator, naming the way out", () => {
		expect(kindWarnings(aware, "simulator")[0]).toContain("kinds.simulator.jsInputs");
		expect(kindWarnings(aware, "dev")[0]).toContain("--kind dev");
	});

	test("release keys on the JS anyway, and a native-only project has nothing to contradict", () => {
		expect(kindWarnings(aware, "release")).toEqual([]);
		expect(kindWarnings(testProject(), "simulator")).toEqual([]);
	});
});

describe("projectRepackers", () => {
	test("Android signs with the project's debug keystore when it exists, else the default repacker", () => {
		const withKey = projectRepackers("/repo/app", (path) => path === "/repo/app/android/app/debug.keystore");
		const without = projectRepackers("/repo/app", () => false);
		expect(without.android).toBe(applyAndroidRepack);
		expect(withKey.android).not.toBe(applyAndroidRepack);
		expect(withKey.ios).toBe(without.ios);
	});
});
