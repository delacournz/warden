import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUILD_COMMAND, defaultBuildCommand } from "./builds.defaults";
import {
	appDirsBelow,
	appStart,
	bundleIdFor,
	CONFIG_FILE,
	dynamicAppConfigDir,
	findWardenConfig,
	JSON_CONFIG_FILE,
	loadProject,
	parseWardenConfig,
} from "./config";

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

	test("android.snapshot is an optional boolean (16-3)", () => {
		const projects = [{ name: "app", bundleId: { android: "com.x.app" } }];
		const off = parseWardenConfig({ projects, android: { snapshot: false } });
		expect(off.success && off.data.android).toEqual({ snapshot: false });
		expect(parseWardenConfig({ projects }).success && parseWardenConfig({ projects })).toBeTruthy();
		expect(parseWardenConfig({ projects, android: { snapshot: "no" } }).success).toBe(false);
		expect(parseWardenConfig({ projects, android: { nope: true } }).success).toBe(false);
	});

	test("e2e suites alone are a valid config, with defaults", () => {
		const res = parseWardenConfig({
			e2e: { mobile: { specsDir: "specs", specs: { a: { entries: ["x.tsx"] } } } },
		});
		if (!res.success) throw new Error(res.error);
		const suite = res.data.e2e?.mobile;
		expect(suite?.base).toBe("main");
		expect(suite?.unmapped).toBe("run");
		expect(suite?.passes).toBe(1);
		expect(suite?.specs.a).toEqual({ entries: ["x.tsx"], paths: [] });
	});

	test("an e2e suite's project must exist; serveReady / serveTimeout need serve; slim is iOS-only", () => {
		const suite = { specsDir: "specs" };
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
		expect(bad({ slim: { except: ["store"] }, platform: "android" }).success).toBe(false);
		expect(bad({ slim: false, platform: "android" }).success).toBe(true);
		expect(bad({ slim: { except: ["store"], keep: ["com.apple.swcd"] }, platform: "ios" }).success).toBe(true);
		const unknown = bad({ slim: { except: ["nope"] } });
		expect(unknown.success).toBe(false);
		if (!unknown.success) expect(unknown.error).toContain("nope");
		expect(bad({ slim: { bogus: 1 } }).success).toBe(false);
	});

	test("top-level slim: boolean or a validated profile", () => {
		const withSlim = (slim: unknown) => parseWardenConfig({ slim, e2e: { s: { specsDir: "specs" } } });
		expect(withSlim(false).success).toBe(true);
		expect(withSlim({ except: ["store"], keep: ["com.apple.swcd"] }).success).toBe(true);
		const unknown = withSlim({ except: ["nope"] });
		expect(unknown.success).toBe(false);
		if (!unknown.success) expect(unknown.error).toContain("nope");
		expect(withSlim({ bogus: 1 }).success).toBe(false);
	});

	test("e2e suite run settings: metro, isolate, jobTimeoutMs and device legs, with defaults", () => {
		const suite = { specsDir: "specs" };
		const parse = (extra: Record<string, unknown>) => parseWardenConfig({ e2e: { s: { ...suite, ...extra } } });
		const plain = parse({});
		if (!plain.success) throw new Error(plain.error);
		expect(plain.data.e2e?.s?.isolate).toBeUndefined();
		expect(plain.data.e2e?.s?.jobTimeoutMs).toBe(600_000);
		expect(plain.data.e2e?.s?.metro).toBeUndefined();

		const full = parse({
			isolate: "spec",
			jobTimeoutMs: 120_000,
			metro: { launchArgs: ["-Flag", "YES"], env: { E2E: "1" } },
			devices: [
				{ profile: "iphone-17", count: 2 },
				{ profile: "ipad", env: { LAYOUT: "regular" }, default: false },
			],
		});
		if (!full.success) throw new Error(full.error);
		expect(full.data.e2e?.s?.metro).toEqual({
			enabled: true,
			port: "8081:100",
			launchArgs: ["-Flag", "YES"],
			open: true,
			env: { E2E: "1" },
			prewarm: true,
			readyTimeout: "2m",
		});
		expect(full.data.e2e?.s?.devices).toEqual([
			{ profile: "iphone-17", count: 2, default: true },
			{ profile: "ipad", count: 1, env: { LAYOUT: "regular" }, default: false },
		]);

		const errorOf = (extra: Record<string, unknown>) => {
			const res = parse(extra);
			return res.success ? "" : res.error;
		};
		expect(errorOf({ devices: [{ profile: "a" }], count: 2 })).toContain("devices replaces profile / count");
		expect(errorOf({ devices: [{ profile: "a" }, { profile: "a" }] })).toContain('duplicate profile "a"');
		expect(errorOf({ devices: [{ profile: "a", default: false }] })).toContain("at least one device leg");
		expect(errorOf({ isolate: "device", passes: 2 })).toContain("passes");
		expect(errorOf({ metro: { port: "nope" } })).toContain("port");
		expect(errorOf({ jobTimeoutMs: 10 })).not.toBe("");
	});

	test("rejects a bad e2e suite", () => {
		const res = parseWardenConfig({ e2e: { mobile: { specsDir: "specs", passes: 0 } } });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("e2e.mobile.passes");
	});

	test("a leftover warmRunners key fails with a migration message", () => {
		const parse = (extra: Record<string, unknown>) =>
			parseWardenConfig({ e2e: { mobile: { specsDir: "specs", ...extra } } });
		const warm = parse({ warmRunners: false });
		expect(warm.success).toBe(false);
		if (!warm.success) expect(warm.error).toContain("e2e.mobile.warmRunners was removed: renamed to warmDrivers");
		expect(parse({ warmDrivers: false }).success).toBe(true);
	});

	test("e2e suite spec: bundle id, launch args and timeouts (durations validated), strict", () => {
		const parse = (spec: unknown) => parseWardenConfig({ e2e: { mobile: { specsDir: "specs", spec } } });
		const full = parse({
			bundleId: "com.x.app",
			launchArgs: ["-Flag", "YES"],
			timeout: "3m",
			actionTimeout: "20s",
			assertionTimeout: "2s",
		});
		if (!full.success) throw new Error(full.error);
		expect(full.data.e2e?.mobile?.spec).toEqual({
			bundleId: "com.x.app",
			launchArgs: ["-Flag", "YES"],
			timeout: "3m",
			actionTimeout: "20s",
			assertionTimeout: "2s",
		});
		expect(parse({}).success).toBe(true);
		expect(parse({ timeout: "soon" }).success).toBe(false);
		expect(parse({ nope: 1 }).success).toBe(false);
	});
});

describe("loadProject", () => {
	test("config at repo root, project picked by containing dir", () => {
		write(JSON_CONFIG_FILE, {
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
			framework: "expo",
			fingerprintCommand: "bun run --silent fingerprint:{platform}",
			eas: { profile: "development-simulator", workflow: ".eas/workflows/dev-build.yml", trigger: false },
			build: { ios: "bun ios", android: DEFAULT_BUILD_COMMAND.android },
			buildConfiguration: "Debug",
			cacheDirs: ["/home/me/.cache/salient-dev-builds"],
			origin: "config",
			source: "repo",
		});
	});

	test("build.configuration: Release flips the default build commands, not explicit ones", () => {
		write(JSON_CONFIG_FILE, {
			projects: [
				{ name: "a", bundleId: { ios: "x" }, build: { configuration: "Release" } },
				{ name: "b", bundleId: { ios: "x" }, build: { configuration: "Release", ios: "my build" } },
			],
		});
		const a = loadProject({ start: dir, env, name: "a" });
		if (!a.success) throw new Error(a.error);
		expect(a.data.buildConfiguration).toBe("Release");
		expect(a.data.build.ios).toBe(defaultBuildCommand("ios", "Release"));
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

		write(JSON_CONFIG_FILE, {
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

	test("variants replace build / fingerprint / eas wholesale; unknown variant errors unless optional", () => {
		write(JSON_CONFIG_FILE, {
			projects: [
				{
					name: "a",
					bundleId: { ios: "x" },
					build: { configuration: "Release", ios: "E2E=1 release build" },
					fingerprint: { include: "native+js", jsInputs: ["src/**"] },
					variants: { dev: { build: { configuration: "Debug" }, fingerprint: { include: "native" } } },
				},
			],
		});
		const base = loadProject({ start: dir, env });
		if (!base.success) throw new Error(base.error);
		expect(base.data.variant).toBeUndefined();
		expect(base.data.buildConfiguration).toBe("Release");
		expect(base.data.jsInputs).toEqual(["src/**"]);

		const dev = loadProject({ start: dir, env, variant: "dev" });
		if (!dev.success) throw new Error(dev.error);
		expect(dev.data.variant).toBe("dev");
		expect(dev.data.buildConfiguration).toBe("Debug");
		expect(dev.data.build.ios).toBe(defaultBuildCommand("ios", "Debug"));
		expect(dev.data.jsInputs).toBeUndefined();

		const missing = loadProject({ start: dir, env, variant: "qa" });
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain('no variant "qa"');
		const optional = loadProject({ start: dir, env, variant: "qa", variantOptional: true });
		if (!optional.success) throw new Error(optional.error);
		expect(optional.data.variant).toBeUndefined();
	});

	test("variant names are validated; an e2e suite's app.variant must exist on its project", () => {
		const bad = parseWardenConfig({ projects: [{ name: "a", bundleId: {}, variants: { dev: { nope: 1 } } }] });
		expect(bad.success).toBe(false);
		const missing = parseWardenConfig({
			projects: [{ name: "a", bundleId: {} }],
			e2e: { s: { project: "a", specsDir: "f", app: { variant: "e2e" } } },
		});
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain('no variant "e2e"');
		const fine = parseWardenConfig({
			projects: [{ name: "a", bundleId: {}, variants: { e2e: { build: { configuration: "Release" } } } }],
			e2e: { s: { project: "a", specsDir: "f", app: { variant: "e2e" } } },
		});
		expect(fine.success).toBe(true);
	});

	test("rejects an unknown build.configuration", () => {
		const res = parseWardenConfig({ projects: [{ name: "a", bundleId: {}, build: { configuration: "Staging" } }] });
		expect(res.success).toBe(false);
	});

	test("ambiguous: several projects, none containing start → error; --name picks", () => {
		write(JSON_CONFIG_FILE, {
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
		write(JSON_CONFIG_FILE, { projects: [{ name: "a", root: "app", bundleId: { ios: "x" } }] });
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

	test("eas: false opts out of the eas.json autodetect; a variant's eas replaces it", () => {
		write("eas.json", {});
		write(JSON_CONFIG_FILE, {
			projects: [
				{
					name: "a",
					bundleId: { ios: "x" },
					eas: false,
					variants: { bench: { eas: { profile: "bench", trigger: false } }, dev: {} },
				},
				{ name: "b", bundleId: { ios: "x" }, variants: { off: { eas: false } } },
			],
		});
		const root = loadProject({ start: dir, env, name: "a" });
		if (!root.success) throw new Error(root.error);
		expect(root.data.eas).toBeUndefined();
		const dev = loadProject({ start: dir, env, name: "a", variant: "dev" });
		if (!dev.success) throw new Error(dev.error);
		expect(dev.data.eas).toBeUndefined();
		const bench = loadProject({ start: dir, env, name: "a", variant: "bench" });
		if (!bench.success) throw new Error(bench.error);
		expect(bench.data.eas).toEqual({ profile: "bench", trigger: false });
		const plain = loadProject({ start: dir, env, name: "b" });
		if (!plain.success) throw new Error(plain.error);
		expect(plain.data.eas).toEqual({ profile: "development-simulator", trigger: false });
		const off = loadProject({ start: dir, env, name: "b", variant: "off" });
		if (!off.success) throw new Error(off.error);
		expect(off.data.eas).toBeUndefined();
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
		write(JSON_CONFIG_FILE, { projects: [{ name: "a", bundleId: { ios: "x" } }] });
		const res = loadProject({ start: dir, env });
		if (!res.success) throw new Error(res.error);
		expect(bundleIdFor(res.data, "ios")).toEqual({ success: true, data: "x" });
		expect(bundleIdFor(res.data, "android").success).toBe(false);
	});
});

describe("findWardenConfig: warden.config.ts", () => {
	const defineConfigPath = join(import.meta.dir, "define-config.ts");

	test("object default export via defineConfig, with defaults applied", () => {
		write(
			CONFIG_FILE,
			`import { defineConfig } from ${JSON.stringify(defineConfigPath)};
const ios: string = "com.x.app";
export default defineConfig({ projects: [{ name: "app", bundleId: { ios } }] });`
		);
		const res = findWardenConfig(dir, dir);
		if (!res.success) throw new Error(res.error);
		expect(res.data?.dir).toBe(dir);
		expect(res.data?.config.projects?.[0]).toEqual({ name: "app", root: ".", bundleId: { ios: "com.x.app" } });
	});

	test("type-only imports are erased, so the package needn't be installed", () => {
		write(
			CONFIG_FILE,
			`import type { WardenConfig } from "@delacour/warden/not-installed";
export default { batches: { smoke: { platform: "ios", cmd: ["true"] } } } satisfies WardenConfig;`
		);
		const res = findWardenConfig(dir, dir);
		if (!res.success) throw new Error(res.error);
		expect(Object.keys(res.data?.config.batches ?? {})).toEqual(["smoke"]);
	});

	test("function export gets configDir + env", () => {
		write(
			CONFIG_FILE,
			"export default ({ configDir, env }) => ({ projects: [{ name: env.APP_NAME, root: configDir, bundleId: {} }] });"
		);
		const res = findWardenConfig(dir, dir, { APP_NAME: "from-env" });
		if (!res.success) throw new Error(res.error);
		expect(res.data?.config.projects?.[0]).toMatchObject({ name: "from-env", root: dir });
	});

	test("loadProject passes its env to a config function", () => {
		write(CONFIG_FILE, "export default ({ env }) => ({ projects: [{ name: 'a', bundleId: { ios: env.HOME } }] });");
		const res = loadProject({ start: dir, env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.bundleId).toEqual({ ios: "/home/me" });
	});

	test("picked up while walking up from a subdir; .mjs works too", () => {
		write("warden.config.mjs", "export default { batches: { a: { platform: 'android', cmd: ['x'] } } };");
		mkdirSync(join(dir, "deep/er"), { recursive: true });
		const res = findWardenConfig(join(dir, "deep/er"), dir);
		if (!res.success) throw new Error(res.error);
		expect(res.data?.dir).toBe(dir);
	});

	test("re-reads an edited file", () => {
		write(CONFIG_FILE, "export default { batches: { a: { platform: 'ios', cmd: ['x'] } } };");
		expect(findWardenConfig(dir, dir).success).toBe(true);
		write(CONFIG_FILE, "export default { batches: { b: { platform: 'ios', cmd: ['x'] } } };");
		const res = findWardenConfig(dir, dir);
		if (!res.success) throw new Error(res.error);
		expect(Object.keys(res.data?.config.batches ?? {})).toEqual(["b"]);
	});

	test("several config files in one dir → error naming them", () => {
		write(CONFIG_FILE, "export default { batches: { a: { platform: 'ios', cmd: ['x'] } } };");
		write(JSON_CONFIG_FILE, { batches: { a: { platform: "ios", cmd: ["x"] } } });
		const res = findWardenConfig(dir, dir);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain(`${CONFIG_FILE}, ${JSON_CONFIG_FILE}`);
	});

	test("invalid shape → error names the .ts file and the path", () => {
		write(CONFIG_FILE, "export default { batches: { a: { platform: 'ios' } } };");
		const res = findWardenConfig(dir, dir);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain(`invalid ${CONFIG_FILE}: batches.a.cmd`);
	});

	test("bad modules → clear errors", () => {
		const cases: [string, string][] = [
			["export const projects = [];", "export default"],
			["export default async () => ({ e2e: {} });", "sync"],
			["export default Promise.resolve({});", "sync"],
			["throw new Error('boom');", "boom"],
			["export default {", join(dir, CONFIG_FILE)],
		];
		for (const [source, message] of cases) {
			write(CONFIG_FILE, source);
			const res = findWardenConfig(dir, dir);
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain(message);
		}
	});
});

describe("dynamicAppConfigDir / appName", () => {
	test("names the app dir whose only config is a dynamic app.config.* without a bundle id", () => {
		mkdirSync(join(dir, "apps", "mobile"), { recursive: true });
		writeFileSync(join(dir, "apps", "mobile", "app.config.ts"), "export default {}");
		expect(dynamicAppConfigDir(join(dir, "apps", "mobile"), dir)).toBe(join(dir, "apps", "mobile"));
	});

	test("undefined when app.json already carries a bundle id, when --bundle-id is given, or when a warden config exists", () => {
		writeFileSync(join(dir, "app.config.ts"), "export default {}");
		expect(dynamicAppConfigDir(dir, dir, { ios: "com.flag" })).toBeUndefined();
		write("app.json", { expo: { slug: "a", ios: { bundleIdentifier: "com.a" } } });
		expect(dynamicAppConfigDir(dir, dir)).toBeUndefined();
		rmSync(join(dir, "app.json"));
		write(JSON_CONFIG_FILE, { projects: [{ name: "a", root: ".", bundleId: { ios: "com.a" } }] });
		expect(dynamicAppConfigDir(dir, dir)).toBeUndefined();
	});

	test("undefined for a plain app.json app and for no app at all", () => {
		expect(dynamicAppConfigDir(dir, dir)).toBeUndefined();
		write("app.json", { expo: { slug: "a" } });
		expect(dynamicAppConfigDir(dir, dir)).toBeUndefined();
	});

	test("appName names an app.config.* project when app.json has no slug", () => {
		writeFileSync(join(dir, "app.config.ts"), "export default {}");
		const res = loadProject({ start: dir, env, stopAt: dir, bundleId: { ios: "com.x" }, appName: "wallet" });
		if (!res.success) throw new Error(res.error);
		expect(res.data.name).toBe("wallet");
		expect(res.data.origin).toBe("app.config");
	});
});

describe("an app below a monorepo root", () => {
	function monorepo(workspaces: unknown): void {
		write("package.json", { name: "root", private: true, workspaces });
		write("yarn.lock", "");
	}

	test("appDirsBelow follows package.json workspaces (literal dirs and * segments) and keeps only app dirs", () => {
		monorepo(["apps/api", "apps/mobile", "packages/*"]);
		write("apps/api/package.json", { name: "api" });
		write("apps/mobile/package.json", { name: "mobile" });
		writeFileSync(join(dir, "apps/mobile/app.config.ts"), "export default {}");
		write("packages/ui/package.json", { name: "ui" });
		write("packages/native/package.json", { name: "native", dependencies: { "react-native": "0.80" } });
		expect(appDirsBelow(dir)).toEqual([join(dir, "apps/mobile"), join(dir, "packages/native")]);
	});

	test("workspaces as { packages } and no workspaces at all (apps/* is looked at)", () => {
		monorepo({ packages: ["apps/*"] });
		write("apps/mobile/app.json", { expo: { slug: "m" } });
		expect(appDirsBelow(dir)).toEqual([join(dir, "apps/mobile")]);
		rmSync(join(dir, "package.json"));
		expect(appDirsBelow(dir)).toEqual([join(dir, "apps/mobile")]);
	});

	test("node_modules and dot dirs are never searched, negated patterns are skipped", () => {
		monorepo(["*", "!apps"]);
		write("node_modules/x/app.json", { expo: {} });
		write(".expo/app.json", { expo: {} });
		expect(appDirsBelow(dir)).toEqual([]);
	});

	test("loadProject from the monorepo root uses the one app below it", () => {
		monorepo(["apps/*"]);
		write("apps/mobile/app.json", { expo: { slug: "wallet", ios: { bundleIdentifier: "com.w" } } });
		const res = loadProject({ start: dir, env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.root).toBe(join(dir, "apps/mobile"));
		expect(res.data.name).toBe("wallet");
		expect(appStart(dir, dir)).toBe(join(dir, "apps/mobile"));
	});

	test("several apps below: the error names them and --project", () => {
		monorepo(["apps/*"]);
		write("apps/a/app.json", { expo: { slug: "a" } });
		write("apps/b/app.json", { expo: { slug: "b" } });
		const res = loadProject({ start: dir, env, stopAt: dir });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error).toContain("apps/a, apps/b");
			expect(res.error).toContain("--project");
		}
		expect(appStart(dir, dir)).toBe(dir);
	});

	test("an app or a warden config above wins: nothing below is looked at", () => {
		write("app.json", { expo: { slug: "top", ios: { bundleIdentifier: "com.top" } } });
		write("apps/mobile/app.json", { expo: { slug: "below" } });
		expect(appStart(dir, dir)).toBe(dir);
		const res = loadProject({ start: dir, env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.name).toBe("top");
	});
});

describe("a bare React Native app", () => {
	function bareApp(): void {
		write("package.json", { name: "wallet-app", dependencies: { "react-native": "0.80" } });
		write("app.json", { name: "Wallet", displayName: "Wallet" });
		write("ios/Wallet.xcodeproj/project.pbxproj", 'PRODUCT_BUNDLE_IDENTIFIER = "com.x.wallet";');
		write("android/app/build.gradle", 'applicationId "com.x.wallet"');
	}

	test("is detected without a warden config: ids from the native projects, react-native build commands", () => {
		bareApp();
		const res = loadProject({ start: dir, env, stopAt: dir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.framework).toBe("react-native");
		expect(res.data.name).toBe("Wallet");
		expect(res.data.bundleId).toEqual({ ios: "com.x.wallet", android: "com.x.wallet" });
		expect(res.data.origin).toBe("react-native");
		expect(res.data.build.ios).toContain("react-native build-ios --mode Debug");
		expect(res.data.build.android).toContain("react-native build-android --mode debug");
		expect(res.data.build.ios).not.toContain("expo");
	});

	test("no app.json is fine too, and --bundle-id still wins", () => {
		bareApp();
		rmSync(join(dir, "app.json"));
		const res = loadProject({ start: dir, env, stopAt: dir, bundleId: { ios: "com.flag" } });
		if (!res.success) throw new Error(res.error);
		expect(res.data.name).toBe("wallet-app");
		expect(res.data.bundleId.ios).toBe("com.flag");
	});

	test("an Expo app stays expo; a warden config can say framework: react-native", () => {
		write("app.json", { expo: { slug: "e", ios: { bundleIdentifier: "com.e" } } });
		write("package.json", { dependencies: { expo: "58", "react-native": "0.80" } });
		const expo = loadProject({ start: dir, env, stopAt: dir });
		if (!expo.success) throw new Error(expo.error);
		expect(expo.data.framework).toBe("expo");
		write(JSON_CONFIG_FILE, { projects: [{ name: "a", bundleId: { ios: "com.a" }, framework: "react-native" }] });
		const configured = loadProject({ start: dir, env, stopAt: dir });
		if (!configured.success) throw new Error(configured.error);
		expect(configured.data.framework).toBe("react-native");
		expect(configured.data.build.ios).toContain("react-native build-ios");
	});

	test("Release builds for react-native", () => {
		expect(defaultBuildCommand("ios", "Release", "react-native")).toContain("--mode Release");
		expect(defaultBuildCommand("android", "Release", "react-native")).toContain("--mode release");
	});
});
