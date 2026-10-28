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
