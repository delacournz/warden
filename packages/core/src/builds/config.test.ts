import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUILD_COMMAND, defaultBuildCommand } from "./builds.defaults";
import { bundleIdFor, CONFIG_FILE, loadProject, parseWardenConfig } from "./config";

let dir: string;
const env = { HOME: "/home/me" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, data: unknown): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), typeof data === "string" ? data : JSON.stringify(data));
}

describe("parseWardenConfig", () => {
	test("applies defaults", () => {
		const res = parseWardenConfig({
			projects: [{ name: "app", bundleId: { ios: "com.x.app" }, eas: {} }],
		});
		if (!res.success) throw new Error(res.error);
		expect(res.data.projects?.[0]).toEqual({
			name: "app",
			root: ".",
			bundleId: { ios: "com.x.app" },
			eas: { profile: "development-simulator", trigger: false },
		});
	});

	test("rejects bad shapes with a path", () => {
		const cases: unknown[] = [
			{},
			{ projects: [] },
			{ projects: [{ name: "", bundleId: {} }] },
			{ projects: [{ name: "a", bundleId: { ios: 1 } }] },
			{ projects: [{ name: "a", bundleId: {}, eas: { trigger: "yes" } }] },
			{ projects: [{ name: "a", bundleId: {}, nope: true }] },
		];
		for (const raw of cases) {
			const res = parseWardenConfig(raw);
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain(CONFIG_FILE);
		}
	});

	test("e2e suites alone are a valid config, with defaults", () => {
		const res = parseWardenConfig({
			e2e: { mobile: { flowsDir: "flows", runner: ["run", "{flowPath}"], flows: { a: { entries: ["x.tsx"] } } } },
		});
		if (!res.success) throw new Error(res.error);
		const suite = res.data.e2e?.mobile;
		expect(suite?.base).toBe("main");
		expect(suite?.unmapped).toBe("run");
		expect(suite?.passes).toBe(1);
		expect(suite?.flows.a).toEqual({ entries: ["x.tsx"], paths: [] });
	});

	test("an e2e suite's project must exist; serveReady / serveTimeout need serve; slim is iOS-only", () => {
		const suite = { flowsDir: "flows", runner: ["run"] };
		const bad = (extra: Record<string, unknown>, projects = true) =>
			parseWardenConfig({
				...(projects ? { projects: [{ name: "app", bundleId: { ios: "x" } }] } : {}),
				e2e: { s: { ...suite, ...extra } },
			});
		expect(bad({ project: "app" }).success).toBe(true);
		const missing = bad({ project: "nope" });
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain('no project "nope"');
		expect(bad({ serveReady: "tcp:1" }).success).toBe(false);
		expect(bad({ serveTimeout: "1m" }).success).toBe(false);
		expect(
			bad({ serve: "x", serveReady: "tcp:1", serveTimeout: "1m", ports: ["8091:5"], env: { A: "1" } }).success
		).toBe(true);
		expect(bad({ ports: ["nope"] }).success).toBe(false);
		expect(bad({ slim: true, platform: "android" }).success).toBe(false);
		expect(bad({ slim: true, platform: "ios", setup: "echo {udid}" }).success).toBe(true);
	});

	test("rejects a bad e2e suite", () => {
		const res = parseWardenConfig({ e2e: { mobile: { flowsDir: "flows", runner: [] } } });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("e2e.mobile.runner");
	});
});

describe("loadProject", () => {
	test("config at repo root, project picked by containing dir", () => {
		write(CONFIG_FILE, {
			projects: [
				{ name: "web", root: "apps/web", bundleId: {} },
				{
					name: "salient",
					root: "apps/salient/app",
					bundleId: { ios: "nz.x.salient", android: "nz.x.salient" },
					fingerprint: { command: "bun run --silent fingerprint:{platform}" },
					eas: { workflow: ".eas/workflows/dev-build.yml" },
					build: { ios: "bun ios" },
				},
			],
		});
		mkdirSync(join(dir, "apps/salient/app/src"), { recursive: true });
		const res = loadProject({ start: join(dir, "apps/salient/app/src"), env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data).toEqual({
			name: "salient",
			root: join(dir, "apps/salient/app"),
			bundleId: { ios: "nz.x.salient", android: "nz.x.salient" },
			fingerprintCommand: "bun run --silent fingerprint:{platform}",
			eas: { profile: "development-simulator", workflow: ".eas/workflows/dev-build.yml", trigger: false },
			build: { ios: "bun ios", android: DEFAULT_BUILD_COMMAND.android },
			buildConfiguration: "Debug",
			cacheDirs: ["/home/me/.cache/salient-dev-builds"],
			origin: "config",
		});
	});

	test("build.configuration: Release flips the default build commands, not explicit ones", () => {
		write(CONFIG_FILE, {
			projects: [
				{ name: "a", bundleId: { ios: "x" }, build: { configuration: "Release" } },
				{ name: "b", bundleId: { ios: "x" }, build: { configuration: "Release", ios: "my build" } },
			],
		});
		const a = loadProject({ start: dir, env, name: "a" });
		if (!a.success) throw new Error(a.error);
		expect(a.data.buildConfiguration).toBe("Release");
		expect(a.data.build.ios).toBe("bunx expo run:ios --configuration Release --no-install --no-bundler");
		expect(a.data.build.android).toBe(defaultBuildCommand("android", "Release"));
		const b = loadProject({ start: dir, env, name: "b" });
		if (!b.success) throw new Error(b.error);
		expect(b.data.build.ios).toBe("my build");
	});

	test("fingerprint.include native+js needs jsInputs, which carry onto the project", () => {
		const bad = parseWardenConfig({
			projects: [{ name: "a", bundleId: {}, fingerprint: { include: "native+js" } }],
		});
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("jsInputs");
		const stray = parseWardenConfig({
			projects: [{ name: "a", bundleId: {}, fingerprint: { jsInputs: ["src/**"] } }],
		});
		expect(stray.success).toBe(false);

		write(CONFIG_FILE, {
			projects: [
				{ name: "a", bundleId: { ios: "x" }, fingerprint: { include: "native+js", jsInputs: ["src/**", "app.json"] } },
				{ name: "b", bundleId: { ios: "x" }, fingerprint: { command: "fp" } },
			],
		});
		const a = loadProject({ start: dir, env, name: "a" });
		if (!a.success) throw new Error(a.error);
		expect(a.data.jsInputs).toEqual(["src/**", "app.json"]);
		expect(a.data.fingerprintCommand).toBeUndefined();
		const b = loadProject({ start: dir, env, name: "b" });
		if (!b.success) throw new Error(b.error);
		expect(b.data.jsInputs).toBeUndefined();
		expect(b.data.fingerprintCommand).toBe("fp");
	});

	test("rejects an unknown build.configuration", () => {
		const res = parseWardenConfig({ projects: [{ name: "a", bundleId: {}, build: { configuration: "Staging" } }] });
		expect(res.success).toBe(false);
	});

	test("ambiguous: several projects, none containing start → error; --name picks", () => {
		write(CONFIG_FILE, {
			projects: [
				{ name: "a", root: "a", bundleId: {} },
				{ name: "b", root: "b", bundleId: {} },
			],
		});
		expect(loadProject({ start: dir, env }).success).toBe(false);
		const named = loadProject({ start: dir, env, name: "b" });
		expect(named.success && named.data.root).toBe(join(dir, "b"));
	});

	test("single project is used from anywhere under the config", () => {
		write(CONFIG_FILE, { projects: [{ name: "a", root: "app", bundleId: { ios: "x" } }] });
		const res = loadProject({ start: dir, env });
		expect(res.success && res.data.name).toBe("a");
	});

	test("auto-detects app.json bundle ids; eas.json enables EAS", () => {
		write("app.json", {
			expo: { slug: "demo", ios: { bundleIdentifier: "com.demo" }, android: { package: "com.demo.a" } },
		});
		write("eas.json", {});
		const res = loadProject({ start: dir, env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.name).toBe("demo");
		expect(res.data.bundleId).toEqual({ ios: "com.demo", android: "com.demo.a" });
		expect(res.data.eas).toEqual({ profile: "development-simulator", trigger: false });
		expect(res.data.origin).toBe("app.json");
		expect(res.data.cacheDirs).toEqual([]);
	});

	test("app.config.ts without bundle id → clear error; --bundle-id fixes it", () => {
		write("app.config.ts", "export default {}");
		const res = loadProject({ start: dir, env, stopAt: dir });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("--bundle-id");
		const withFlag = loadProject({ start: dir, env, stopAt: dir, bundleId: { ios: "com.flag" } });
		if (!withFlag.success) throw new Error(withFlag.error);
		expect(withFlag.data.bundleId).toEqual({ ios: "com.flag" });
		expect(withFlag.data.origin).toBe("app.config");
		expect(withFlag.data.eas).toBeUndefined();
	});

	test("nothing found → error", () => {
		expect(loadProject({ start: dir, env, stopAt: dir }).success).toBe(false);
	});

	test("bundleIdFor", () => {
		write(CONFIG_FILE, { projects: [{ name: "a", bundleId: { ios: "x" } }] });
		const res = loadProject({ start: dir, env });
		if (!res.success) throw new Error(res.error);
		expect(bundleIdFor(res.data, "ios")).toEqual({ success: true, data: "x" });
		expect(bundleIdFor(res.data, "android").success).toBe(false);
	});
});
