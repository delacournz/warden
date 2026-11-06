import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import { err, ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { type CiDeps, createCiCommand } from "./ci";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const gitListing: Exec = async (cmd) =>
	cmd[0] === "git"
		? { exitCode: 0, stdout: "100644 abc 0\tsrc/a.ts\n", stderr: "" }
		: { exitCode: 1, stdout: "", stderr: "unexpected" };

type Seen = { fingerprintDir?: string; profile?: string | undefined };

function deps(seen: Seen, over: Partial<CiDeps> = {}): CiDeps {
	return {
		nativeFingerprint: async (_ctx, dir) => {
			seen.fingerprintDir = dir;
			return ok("f1b4");
		},
		goldenName: async (_ctx, profile) => {
			seen.profile = profile;
			return ok("warden-golden-iphone-17-645b28cbef-r2");
		},
		...over,
	};
}

function setup(argv: string[]): TestContext {
	ctx = testContext(argv, { exec: gitListing });
	ctx.env = { ...ctx.env, WARDEN_HOME: "/wh", HOME: "/home/ci", RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64" };
	return ctx;
}

describe("warden ci cache", () => {
	test("--json prints the three groups keyed like the e2e action", async () => {
		const seen: Seen = {};
		const c = setup(["cache", "--json"]);
		expect(await createCiCommand(deps(seen)).run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.builds).toEqual({
			kind: "paths",
			key: "warden-e2e-v1-builds-macOS-ARM64-f1b4",
			paths: ["/wh/builds", "!/wh/builds/*/ios/*/simulator/repacks"],
		});
		expect(out.repack.key).toMatch(/^warden-e2e-v1-repack-macOS-ARM64-f1b4-[0-9a-f]{16}$/);
		expect(out.golden).toMatchObject({
			kind: "archive",
			key: "warden-e2e-v1-macOS-ARM64-warden-golden-iphone-17-645b28cbef-r2",
			paths: ["/home/ci/warden-goldens"],
			afterRestore: "warden golden import /home/ci/warden-goldens",
		});
		expect(seen.fingerprintDir).toBe(c.cwd);
		expect(seen.profile).toBeUndefined();
	});

	test("--prefix, --profile, --golden-dir and --js-input change the keys and paths", async () => {
		const seen: Seen = {};
		const calls: (readonly string[])[] = [];
		const c = setup([
			"cache",
			"--json",
			"--prefix",
			"app-v2",
			"--profile",
			"ipad-air",
			"--golden-dir",
			"goldens",
			"--js-input",
			"app",
			"--js-input",
			"package.json",
		]);
		c.exec = async (cmd, opts) => {
			calls.push(cmd);
			return gitListing(cmd, opts);
		};
		expect(await createCiCommand(deps(seen)).run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.builds.key).toBe("app-v2-builds-macOS-ARM64-f1b4");
		expect(out.golden.paths).toEqual([`${c.cwd}/goldens`]);
		expect(out.golden.beforeSave).toContain("--profile ipad-air");
		expect(seen.profile).toBe("ipad-air");
		expect(calls).toContainEqual(["git", "ls-files", "-s", "--", "app", "package.json"]);
	});

	test("without --json it prints one line per group", async () => {
		const c = setup(["cache"]);
		expect(await createCiCommand(deps({})).run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("builds");
		expect(text).toContain("warden-e2e-v1-builds-macOS-ARM64-f1b4");
		expect(text).toContain("golden");
	});

	test("a fingerprint failure exits 1 and names it", async () => {
		const c = setup(["cache", "--json"]);
		const failing = deps({}, { nativeFingerprint: async () => err("no app.config here") });
		expect(await createCiCommand(failing).run(c)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ ok: false, error: { message: "no app.config here" } });
	});

	test("--platform android is refused: the golden is iOS only", async () => {
		const c = setup(["cache", "--platform", "android"]);
		expect(await createCiCommand(deps({})).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("ios");
	});
});
