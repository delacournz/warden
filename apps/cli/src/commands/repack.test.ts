import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepackInput, repackApp } from "@delacour/warden-core/builds/repack";
import { err, ok } from "@delacour/warden-types/result";
import { OWNER_ENV } from "../simctl.testing";
import { fakeExec, type TestContext, testContext } from "../testing";
import type { AppDeps } from "./app";
import { createRepackCommand } from "./repack";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const deps: AppDeps = { pid: 1, sleep: async () => {}, pidAlive: () => false };

function setup(argv: string[]): TestContext {
	ctx = testContext(argv);
	mkdirSync(join(ctx.cwd, "app"), { recursive: true });
	writeFileSync(
		join(ctx.cwd, "warden.config.json"),
		JSON.stringify({ projects: [{ name: "demo", root: "app", bundleId: { ios: "com.demo", android: "com.demo" } }] })
	);
	ctx.exec = fakeExec([["git", { exitCode: 128 }]]);
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

type Run = typeof repackApp;
const repacked: Awaited<ReturnType<Run>> = ok({
	kind: "repacked",
	artifact: "/cache/App.app",
	hash: "fp:js1",
	baseHash: "fp:base",
	jsKey: "js1",
	bundleMs: 1500,
});

describe("warden repack", () => {
	test("--json reports the keys, artifact and bundle time; the input is the simulator kind of the project", async () => {
		const seen: RepackInput[] = [];
		const c = setup(["ios", "--json"]);
		const code = await createRepackCommand(deps, async (input) => {
			seen.push(input);
			return repacked;
		}).run(c);
		expect(code).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			result: "repacked",
			platform: "ios",
			baseHash: "fp:base",
			hash: "fp:js1",
			jsKey: "js1",
			artifact: "/cache/App.app",
			bundleMs: 1500,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ platform: "ios", build: true, eas: false });
		expect(seen[0]?.force).toBeUndefined();
		expect(seen[0]?.project.name).toBe("demo");
	});

	test("--force reaches the repack", async () => {
		const seen: RepackInput[] = [];
		const c = setup(["android", "--force", "--json"]);
		await createRepackCommand(deps, async (input) => {
			seen.push(input);
			return repacked;
		}).run(c);
		expect(seen[0]).toMatchObject({ platform: "android", force: true });
	});

	test("a reused repack is reported as reused, exit 0", async () => {
		const c = setup(["ios", "--json"]);
		const code = await createRepackCommand(deps, async () =>
			ok({ kind: "reused", artifact: "/a", hash: "h", baseHash: "b", jsKey: "j" })
		).run(c);
		expect(code).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).result).toBe("reused");
	});

	test("a fallback names the reason and exits 1", async () => {
		const c = setup(["android", "--json"]);
		const code = await createRepackCommand(deps, async () => ok({ kind: "fallback", reason: "images changed" })).run(c);
		expect(code).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			result: "fallback",
			platform: "android",
			reason: "images changed",
		});
	});

	test("an error is reported on stderr, exit 1, and as the --json failure envelope", async () => {
		const c = setup(["ios", "--json"]);
		const code = await createRepackCommand(deps, async () => err("repack: metro exploded")).run(c);
		expect(code).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden repack: repack: metro exploded");
		expect(JSON.parse(c.stdout[0] ?? "")).toMatchObject({
			ok: false,
			command: "repack",
			error: { code: "failed", message: "repack: metro exploded" },
		});
	});

	test("an unknown platform is refused", async () => {
		const c = setup(["windows"]);
		expect(await createRepackCommand(deps, async () => repacked).run(c)).toBe(1);
	});
});
