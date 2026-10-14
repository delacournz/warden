import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_E2E_RUNNER } from "@delacour/warden-core/affected/affected.defaults";
import { findWardenConfig } from "@delacour/warden-core/builds/config";
import { type TestContext, testContext } from "../testing";
import { initCommand } from "./init";

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
	test("a fresh app: bundle id into app.json, warden.config.ts, e2e.config.ts and a first flow; names what to install", async () => {
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
			flowsDir: "e2e",
			runner: DEFAULT_E2E_RUNNER,
			mode: "single",
			platform: "ios",
			count: 2,
			app: true,
			metro: { enabled: true },
		});

		expect(read(c, "e2e.config.ts")).toContain('bundleId: "com.demo.fresh"');
		expect(read(c, "e2e.config.ts")).toContain("WARDEN_METRO_URL");
		expect(read(c, "e2e/smoke.e2e.ts")).toContain('from "@e2e-dev/mobile"');

		const log = c.stderr.join("\n");
		expect(log).toContain("bunx expo install expo-dev-client");
		expect(log).toContain("bun add -d e2e @e2e-dev/mobile");
		expect(log).toContain("warden dev");
	});

	test("ids already in app.json are kept; installed packages are not asked for again", async () => {
		const expo = { slug: "fresh", ios: { bundleIdentifier: "com.a.ios" }, android: { package: "com.a.droid" } };
		const c = setup(["--json"], expo, { "expo-dev-client": "1", e2e: "1", "@e2e-dev/mobile": "1" });
		expect(await initCommand.run(c)).toBe(0);
		expect(JSON.parse(read(c, "app.json"))).toEqual({ expo });
		expect(read(c, "warden.config.ts")).toContain('{ ios: "com.a.ios", android: "com.a.droid" }');
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			root: c.cwd,
			written: ["warden.config.ts", "e2e.config.ts", "e2e/smoke.e2e.ts"],
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

	test("existing files are left alone (--force overwrites); existing flows mean no smoke flow", async () => {
		const c = setup(["--json"], { slug: "fresh", ios: { bundleIdentifier: "com.a" } });
		writeFileSync(join(c.cwd, "warden.config.ts"), "export default {};\n");
		mkdirSync(join(c.cwd, "e2e"));
		writeFileSync(join(c.cwd, "e2e/login.e2e.ts"), "export {};\n");
		expect(await initCommand.run(c)).toBe(0);
		expect(read(c, "warden.config.ts")).toBe("export default {};\n");
		expect(existsSync(join(c.cwd, "e2e/smoke.e2e.ts"))).toBe(false);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			written: ["e2e.config.ts"],
			skipped: ["warden.config.ts"],
		});

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
		expect(JSON.parse(c.stdout.join("\n")).written).toEqual(["e2e.config.ts", "e2e/smoke.e2e.ts"]);
	});

	test("--dry-run writes nothing", async () => {
		const c = setup(["--dry-run", "--bundle-id", "com.a"], { slug: "fresh" });
		expect(await initCommand.run(c)).toBe(0);
		expect(JSON.parse(read(c, "app.json"))).toEqual({ expo: { slug: "fresh" } });
		expect(existsSync(join(c.cwd, "warden.config.ts"))).toBe(false);
		expect(c.stderr.join("\n")).toContain("would write warden.config.ts");
	});

	test("not an Expo app → exit 1", async () => {
		ctx = testContext([]);
		expect(await initCommand.run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("app.json");
	});
});
