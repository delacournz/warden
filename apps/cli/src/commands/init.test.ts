import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_MENU_OFF_ARGS } from "@delacour/warden-core/affected/affected.defaults";
import { findWardenConfig } from "@delacour/warden-core/builds/config";
import { type TestContext, testContext } from "../testing";
import { currentBuild } from "../update/build-info";
import { initCommand } from "./init";
import { SMOKE_SPEC_SOURCE } from "./init.data";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

/** A context whose cwd is an Expo app with this `app.json` (`expo` key) and `package.json` dependencies. */
function setup(argv: string[], expo: Record<string, unknown>, dependencies: Record<string, string> = {}): TestContext {
	ctx = testContext(argv);
	const app = join(ctx.cwd, "fresh-app");
	mkdirSync(app);
	writeFileSync(join(app, "app.json"), JSON.stringify({ expo }));
	writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies }));
	ctx.cwd = app;
	return ctx;
}

const read = (c: TestContext, file: string) => readFileSync(join(c.cwd, file), "utf8");

describe("warden init", () => {
	test("a fresh app: bundle id into app.json, warden.config.ts and a first spec; names what to install", async () => {
		const c = setup(["--bundle-id", "com.demo.fresh"], { slug: "fresh", version: "1.0.0" });
		expect(await initCommand.run(c)).toBe(0);

		expect(JSON.parse(read(c, "app.json"))).toEqual({
			expo: {
				slug: "fresh",
				version: "1.0.0",
				ios: { bundleIdentifier: "com.demo.fresh" },
				android: { package: "com.demo.fresh" },
			},
		});

		const found = findWardenConfig(c.cwd, c.cwd, {});
		if (!found.success || !found.data) throw new Error(found.success ? "no config written" : found.error);
		expect(found.data.config.projects).toMatchObject([
			{ name: "fresh", bundleId: { ios: "com.demo.fresh", android: "com.demo.fresh" } },
		]);
		expect(found.data.config.e2e?.fresh).toMatchObject({
			project: "fresh",
			specsDir: "e2e",
			isolate: "device",
			platform: "ios",
			count: 2,
			app: true,
			metro: { enabled: true, launchArgs: DEV_MENU_OFF_ARGS },
		});
		expect(found.data.config.e2e?.fresh).not.toHaveProperty("runner");
		expect(existsSync(join(c.cwd, "e2e.config.ts"))).toBe(false);
		expect(read(c, "e2e/smoke.e2e.ts")).toContain('from "@delacour/warden-e2e"');

		const log = c.stderr.join("\n");
		expect(log).toContain("bunx expo install expo-dev-client");
		expect(log).toContain(`bun add -d @delacour/warden-e2e@${currentBuild().version}`);
		expect(log).toContain("warden dev");
	});

	test("ids already in app.json are kept; installed packages are not asked for again", async () => {
		const expo = { slug: "fresh", ios: { bundleIdentifier: "com.a.ios" }, android: { package: "com.a.droid" } };
		const c = setup(["--json"], expo, { "expo-dev-client": "1", "@delacour/warden-e2e": "1" });
		expect(await initCommand.run(c)).toBe(0);
		expect(JSON.parse(read(c, "app.json"))).toEqual({ expo });
		expect(read(c, "warden.config.ts")).toContain('{ ios: "com.a.ios", android: "com.a.droid" }');
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			root: c.cwd,
			written: ["warden.config.ts", "e2e/smoke.e2e.ts"],
			skipped: [],
			install: [],
		});
	});

	test("no bundle id anywhere → exit 1 asking for --bundle-id, nothing written", async () => {
		const c = setup([], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--bundle-id");
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
	});

	test("existing files are left alone (--force overwrites); existing specs mean no smoke spec", async () => {
		const c = setup(["--json"], { slug: "fresh", ios: { bundleIdentifier: "com.a" } });
		writeFileSync(join(c.cwd, "warden.config.ts"), "export default {};\n");
		mkdirSync(join(c.cwd, "e2e"));
		writeFileSync(join(c.cwd, "e2e/login.e2e.ts"), "export {};\n");
		expect(await initCommand.run(c)).toBe(0);
		expect(read(c, "warden.config.ts")).toBe("export default {};\n");
		expect(existsSync(join(c.cwd, "e2e/smoke.e2e.ts"))).toBe(false);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ written: [], skipped: ["warden.config.ts"] });

		c.argv = ["--force"];
		expect(await initCommand.run(c)).toBe(0);
		expect(read(c, "warden.config.ts")).toContain("projects");
	});

	test("a warden config in another format is never replaced", async () => {
		const c = setup(["--force", "--json"], { slug: "fresh", ios: { bundleIdentifier: "com.a" } });
		writeFileSync(join(c.cwd, "warden.config.json"), "{}\n");
		expect(await initCommand.run(c)).toBe(0);
		expect(read(c, "warden.config.json")).toBe("{}\n");
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
		expect(JSON.parse(c.stdout.join("\n")).written).toEqual(["e2e/smoke.e2e.ts"]);
	});

	test("--dry-run writes nothing", async () => {
		const c = setup(["--dry-run", "--bundle-id", "com.a"], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(0);
		expect(JSON.parse(read(c, "app.json"))).toEqual({ expo: { slug: "fresh" } });
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
		expect(c.stderr.join("\n")).toContain("would write warden.config.ts");
	});

	test("the e2e package is installed with the checkout's package manager, pinned to this warden", async () => {
		const expo = { slug: "fresh", ios: { bundleIdentifier: "com.a" } };
		const cases: Array<[lockfile: string | undefined, command: string]> = [
			[undefined, "bun add -d"],
			["bun.lock", "bun add -d"],
			["pnpm-lock.yaml", "pnpm add -D"],
			["yarn.lock", "yarn add -D"],
			["package-lock.json", "npm install -D"],
		];
		for (const [lockfile, command] of cases) {
			const c = setup([], expo, { "expo-dev-client": "1" });
			if (lockfile) writeFileSync(join(c.cwd, lockfile), "");
			expect(await initCommand.run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain(`${command} @delacour/warden-e2e@${currentBuild().version}`);
			c.cleanup();
		}
	});

	test("--platform android writes an android suite with the android package", async () => {
		const c = setup(["--platform", "android"], { slug: "fresh", android: { package: "com.a.droid" } });
		expect(await initCommand.run(c)).toBe(0);
		const found = findWardenConfig(c.cwd, c.cwd, {});
		if (!found.success || !found.data) throw new Error("no config written");
		expect(found.data.config.e2e?.fresh).toMatchObject({ platform: "android", project: "fresh", app: true });
		expect(read(c, "warden.config.ts")).toContain('platform: "android"');
		expect(read(c, "warden.config.ts")).not.toContain("EXDevMenu");
	});

	test("--platform android without an android package → exit 1 asking for --bundle-id", async () => {
		const c = setup(["--platform", "android"], { slug: "fresh", ios: { bundleIdentifier: "com.a.ios" } });
		expect(await initCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--bundle-id");
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
	});

	test("--platform android --bundle-id fills the package", async () => {
		const c = setup(["--platform", "android", "--bundle-id", "com.a.new"], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(0);
		expect(JSON.parse(read(c, "app.json")).expo.android.package).toBe("com.a.new");
	});

	test("a bad --platform → exit 1, nothing written", async () => {
		const c = setup(["--platform", "windows", "--bundle-id", "com.a"], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--platform");
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
	});

	test("the next steps are listed in order", async () => {
		const c = setup(["--bundle-id", "com.a"], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(0);
		const log = c.stderr.join("\n");
		const next = log.slice(log.indexOf("next:"));
		expect(next.indexOf("install")).toBeLessThan(next.indexOf("testID"));
		expect(next.indexOf("testID")).toBeLessThan(next.indexOf("warden e2e"));
	});

	test("the smoke spec's next-step example names the import and fixture it needs", () => {
		expect(SMOKE_SPEC_SOURCE).toContain('import { test } from "@delacour/warden-e2e"');
		expect(SMOKE_SPEC_SOURCE).toContain("Add `expect` to the import and `screen` to the fixtures");
		expect(SMOKE_SPEC_SOURCE).toContain("expect(screen.getByTestId");
	});

	test("not an Expo app → exit 1", async () => {
		ctx = testContext([]);
		expect(await initCommand.run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("app.json");
	});
});
