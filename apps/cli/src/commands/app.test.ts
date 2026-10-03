import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeApp } from "@delacour/warden-core/builds/builds.testing";
import { getInstall, recordInstall, storeArtifact } from "@delacour/warden-core/builds/cache";
import type { ExecResult } from "@delacour/warden-core/exec";
import { OWNER_ENV } from "../simctl.testing";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { type AppDeps, createAppCommand } from "./app";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const HASH = "abc123def456";
const deps: AppDeps = { pid: 1, sleep: async () => {}, pidAlive: () => false };

function setup(argv: string[], extra: Array<[string, Partial<ExecResult>]> = [], calls: string[][] = []): TestContext {
	ctx = testContext(argv);
	const root = join(ctx.cwd, "app");
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(ctx.cwd, "warden.config.json"),
		JSON.stringify({
			projects: [
				{
					name: "demo",
					root: "app",
					bundleId: { ios: "com.demo", android: "com.demo" },
					fingerprint: { command: "fp {platform}" },
				},
			],
		})
	);
	ctx.exec = fakeExec(
		[
			...extra,
			["sh -c fp ios", { stdout: JSON.stringify({ hash: HASH }) }],
			["sh -c fp android", { stdout: `${HASH}ff` }],
			["git", { exitCode: 128 }],
		],
		calls
	);
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

async function seed(c: TestContext): Promise<string> {
	const res = await storeArtifact({
		store: c.db,
		env: c.env,
		projectKey: `path:${realpathSync(join(c.cwd, "app"))}`,
		platform: "ios",
		profile: "local",
		hash: HASH,
		artifact: fakeApp(join(c.cwd, "src")),
		source: "import",
		now: 1,
	});
	if (!res.success) throw new Error(res.error);
	return res.data.path;
}

describe("warden app fingerprint (native+js)", () => {
	test("the printed fingerprint is the JS-aware key; native is reported alongside", async () => {
		const c = setup(["fingerprint", "ios", "--json"], [["git ls-files", { stdout: "src/a.ts" }]]);
		mkdirSync(join(c.cwd, "app", "src"), { recursive: true });
		writeFileSync(join(c.cwd, "app", "src", "a.ts"), "export {}");
		writeFileSync(
			join(c.cwd, "warden.config.json"),
			JSON.stringify({
				projects: [
					{
						name: "demo",
						root: "app",
						bundleId: { ios: "com.demo" },
						fingerprint: { command: "fp {platform}", include: "native+js", jsInputs: ["src/**"] },
					},
				],
			})
		);
		expect(await createAppCommand(deps).run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.native).toEqual({ ios: HASH });
		expect(out.fingerprints.ios).toMatch(/^[0-9a-f]{40}$/);
		expect(out.fingerprints.ios).not.toBe(HASH);
	});
});

describe("warden app fingerprint", () => {
	test("both platforms by default, --json, hash logged loudly to stderr", async () => {
		const c = setup(["fingerprint", "--json"]);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createAppCommand(deps).run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out).toMatchObject({ project: "demo", fingerprints: { ios: HASH, android: `${HASH}ff` } });
		expect(ui.events[0]).toBe("spin: fingerprinting ios + android…");
		expect(ui.events).toContain(`log: [warden] ios fingerprint: ${HASH}`);
		expect(ui.events.at(-1)).toBe("stop");
	});

	test("one platform, text output", async () => {
		const c = setup(["fingerprint", "android"]);
		expect(await createAppCommand(deps).run(c)).toBe(0);
		expect(c.stdout.join("\n")).toBe(`android  ${HASH}ff`);
	});
});

describe("warden app ensure", () => {
	test("--udid: cache hit → simctl install, then installed on the second run", async () => {
		const calls: string[][] = [];
		const c = setup(
			["ensure", "ios", "--udid", "U1", "--json"],
			[
				["xcrun simctl install U1", {}],
				["xcrun simctl get_app_container U1 com.demo", { stdout: "/x" }],
			],
			calls
		);
		const path = await seed(c);
		const cmd = createAppCommand(deps);
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ appPath: path, hash: HASH, source: "cache", installed: true });
		expect(getInstall(c.db, "ios", "U1", "com.demo")?.hash).toBe(HASH);

		c.stdout.length = 0;
		calls.length = 0;
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).source).toBe("installed");
		expect(calls.some((cmdline) => cmdline.join(" ").startsWith("xcrun simctl install"))).toBe(false);
	});

	test("--clean: uninstalls then installs although the device is already at the hash", async () => {
		const calls: string[][] = [];
		const c = setup(["ensure", "ios", "--udid", "U1", "--clean", "--json"], [], calls);
		const base = c.exec;
		let present = true;
		c.exec = async (cmd, opts) => {
			const joined = cmd.join(" ");
			if (!joined.startsWith("xcrun simctl")) return base(cmd, opts);
			calls.push([...cmd]);
			present = joined.startsWith("xcrun simctl install") || (present && !joined.includes("uninstall"));
			const probe = joined.startsWith("xcrun simctl get_app_container");
			return { exitCode: probe && !present ? 1 : 0, stdout: probe ? "/x" : "", stderr: "" };
		};
		await seed(c);
		recordInstall(c.db, { platform: "ios", deviceId: "U1", bundleId: "com.demo", hash: HASH, installedAt: 1 });
		expect(await createAppCommand(deps).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).source).toBe("cache");
		const verbs = calls.map((x) => x.join(" ")).filter((x) => /simctl (un)?install/.test(x));
		expect(verbs).toEqual(["xcrun simctl uninstall U1 com.demo", expect.stringContaining("xcrun simctl install U1")]);
	});

	test("--clean with --no-install is an error", async () => {
		const c = setup(["ensure", "ios", "--no-install", "--clean"]);
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--clean needs a device");
	});

	test("no --udid/--lease → the caller's single leased device", async () => {
		const c = setup(
			["ensure", "ios", "--json"],
			[
				["xcrun simctl install U7", {}],
				["xcrun simctl get_app_container U7", { stdout: "/x" }],
			]
		);
		await seed(c);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U7", name: "warden-iphone-17-7" },
				owner: { kind: "agent", sessionId: "me", cwd: c.cwd },
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await createAppCommand(deps).run(c)).toBe(0);
		expect(getInstall(c.db, "ios", "U7", "com.demo")).toBeDefined();
	});

	test("--lease id resolves the device", async () => {
		const c = setup(
			["ensure", "ios"],
			[
				["xcrun simctl install U9", {}],
				["xcrun simctl get_app_container U9", { stdout: "/x" }],
			]
		);
		await seed(c);
		const lease = c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U9", name: "n" },
				owner: { kind: "agent", sessionId: "someone", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
		c.argv = ["ensure", "ios", "--lease", lease.id];
		expect(await createAppCommand(deps).run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("installed on U9");
	});

	test("no device leased and no flags → exit 1 with a hint", async () => {
		const c = setup(["ensure", "ios"]);
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden claim ios");
	});

	test("--no-install --no-eas --no-build on a miss → exit 1, nothing built", async () => {
		const calls: string[][] = [];
		const c = setup(["ensure", "ios", "--no-install", "--no-eas", "--no-build"], [], calls);
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain(`no build for fingerprint ${HASH}`);
		expect(calls.some((cmdline) => cmdline.includes("eas-cli"))).toBe(false);
	});

	test("unknown subcommand / bad platform / unknown option → exit 1", async () => {
		const c = setup(["nope"]);
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown command 'nope'");
		c.argv = ["ensure", "windows"];
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain('unknown platform "windows"');
		c.argv = ["ensure", "ios", "--bogus"];
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
	});

	test("no platform in a terminal → asks; spinner covers the ensure", async () => {
		const c = setup(
			["ensure", "--udid", "U1", "--json"],
			[
				["xcrun simctl install U1", {}],
				["xcrun simctl get_app_container U1 com.demo", { stdout: "/x" }],
			]
		);
		await seed(c);
		const ui = scriptedUi({ interactive: true, select: ["ios"] });
		c.ui = ui;
		expect(await createAppCommand(deps).run(c)).toBe(0);
		expect(ui.events[0]).toBe("select: Which platform?");
		expect(ui.events[1]).toBe("spin: ensuring the ios app…");
		expect(ui.events.slice(-2)).toEqual(["ok: ios app ready (cache)", "stop"]);
		expect(JSON.parse(c.stdout.join("\n")).source).toBe("cache");
	});

	test("no platform, not a terminal → exit 1", async () => {
		const c = setup(["ensure", "--no-install"]);
		expect(await createAppCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("missing platform");
	});
});
