import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import type { RunContext } from "./adapter.types";
import { createWardenAdapter, simdSocketPath, type WardenDeps, wardenArgv, wardenSpecEnv } from "./warden";

const packageRoot = join(import.meta.dir, "../..");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/warden", name), "utf8");

function ctxOf(exec: RunContext["exec"], overrides: Partial<RunContext> = {}): RunContext {
	return {
		platform: "ios",
		udid: "U1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/app",
		outDir: "/out",
		cold: true,
		retries: 0,
		env: { WARDEN_BUN: "bun" },
		exec,
		log: () => undefined,
		packageRoot,
		repoRoot: "/repo",
		...overrides,
	};
}

function depsOf(files: Record<string, string>, extra: Partial<WardenDeps> = {}): WardenDeps & { written: string[] } {
	const written: string[] = [];
	return {
		written,
		exists: (p) => p in files,
		readText: (p) => files[p],
		writeText: (p) => {
			written.push(p);
		},
		resolvePreload: () => "/repo/packages/e2e/src/preload.ts",
		home: () => "/home/u",
		...extra,
	};
}

describe("wardenArgv / wardenSpecEnv", () => {
	test("bun test argv adds the margin and the retry flag only when asked", () => {
		expect(wardenArgv({ preload: "/p", specPaths: ["/a", "/b"], timeoutMs: 1000, retries: 0 })).toEqual([
			"test",
			"--preload",
			"/p",
			"--timeout",
			"31000",
			"/a",
			"/b",
		]);
		expect(wardenArgv({ preload: "/p", specPaths: [], timeoutMs: 1000, retries: 2 })).toContain("--retry");
	});

	test("env contract", () => {
		const env = wardenSpecEnv({
			udid: "U",
			platform: "ios",
			bundleId: "b",
			out: "/o",
			specsDir: "/f",
			helperDir: "/h",
			version: "0.1.0",
		});
		expect(env).toMatchObject({ WARDEN_UDID: "U", WARDEN_VERSION: "0.1.0", WARDEN_LAUNCH_ARGS: "[]" });
		expect(env.WARDEN_SIMD_SOCKET).toBeUndefined();
	});

	test("socket path honours WARDEN_HOME", () => {
		expect(simdSocketPath({}, "/h", "U")).toBe("/h/.warden/simd/U.sock");
		expect(simdSocketPath({ WARDEN_HOME: "/w" }, "/h", "U")).toBe("/w/simd/U.sock");
	});
});

describe("doctor", () => {
	const exec = fakeExec([{ cmd: "bun", result: { stdout: "1.3.14\n" } }]);
	const files = {
		"/repo/packages/e2e/native/dist/warden-simd": "",
		"/repo/apps/cli/package.json": '{"version":"0.1.0"}',
	};

	test("ok with the helper built", async () => {
		const res = await createWardenAdapter(depsOf(files)).doctor(ctxOf(exec));
		expect(res.ok).toBe(true);
	});

	test("missing helper names the build command", async () => {
		const res = await createWardenAdapter(depsOf({ "/repo/apps/cli/package.json": '{"version":"0.1.0"}' })).doctor(
			ctxOf(exec)
		);
		expect(res).toMatchObject({ ok: false, installHint: "bun run --cwd packages/e2e native:build" });
	});

	test("android needs no helper", async () => {
		const res = await createWardenAdapter(depsOf({ "/repo/apps/cli/package.json": '{"version":"0.1.0"}' })).doctor(
			ctxOf(exec, { platform: "android" })
		);
		expect(res.ok).toBe(true);
	});
});

describe("run", () => {
	const results = fixture("results.jsonl");

	test("spawns bun test over the five files with the env contract and joins the results", async () => {
		const exec = fakeExec([{ cmd: "bun", result: { code: 1 } }]);
		const deps = depsOf({
			"/repo/apps/cli/package.json": '{"version":"0.1.0"}',
			"/out/warden-out/results.jsonl": results,
		});
		const res = await createWardenAdapter(deps).run(ctxOf(exec));
		const call = exec.calls[0];
		expect(call?.args.slice(0, 4)).toEqual(["test", "--preload", "/repo/packages/e2e/src/preload.ts", "--timeout"]);
		expect(call?.args.filter((a) => a.endsWith(".e2e.ts"))).toHaveLength(5);
		expect(call?.options?.env).toMatchObject({ WARDEN_UDID: "U1", WARDEN_E2E_OUT: "/out/warden-out" });
		expect(call?.options?.cwd).toBe(packageRoot);
		expect(res.success).toBe(true);
	});

	test("a test with a trace carries its steps and its untraced time into the canonical result", async () => {
		const dir = "/out/onboarding/onboarding-steps-through-to-sign-in-a1b2c3";
		const exec = fakeExec([{ cmd: "bun", result: { code: 1 } }]);
		const deps = depsOf({
			"/repo/apps/cli/package.json": '{"version":"0.1.0"}',
			"/out/warden-out/results.jsonl": results,
			[`${dir}/trace.jsonl`]: fixture("trace-onboarding.jsonl"),
		});
		const res = await createWardenAdapter(deps).run(ctxOf(exec));
		if (!res.success) throw new Error("run failed");
		const onboarding = res.data.tests.find((t) => t.id === "onboarding/steps-to-sign-in");
		expect(onboarding?.steps?.map((s) => s.label)).toEqual([
			"open nz.co.delacour.warden.example",
			"tap welcome-next",
			"toBeVisible sign-in-screen",
		]);
		expect(typeof onboarding?.untracedMs).toBe("number");
		const withoutTrace = res.data.tests.find((t) => t.id === "sign-in/locked-account");
		expect(withoutTrace).not.toHaveProperty("untracedMs");
	});

	test("results with an unknown test are a parity breach", async () => {
		const stray = `${JSON.stringify({
			file: "/x/stray.e2e.ts",
			title: ["t"],
			status: "passed",
			durationMs: 1,
			startedAt: 1,
			device: { udid: "U1", platform: "ios" },
		})}\n`;
		const deps = depsOf({
			"/repo/apps/cli/package.json": '{"version":"0.1.0"}',
			"/out/warden-out/results.jsonl": stray,
		});
		const res = await createWardenAdapter(deps).run(ctxOf(fakeExec([{ cmd: "bun", result: {} }])));
		expect(res).toMatchObject({ success: false, error: { kind: "failed" } });
	});

	test("no results.jsonl fails with the output tail", async () => {
		const deps = depsOf({ "/repo/apps/cli/package.json": '{"version":"0.1.0"}' });
		const exec = fakeExec([{ cmd: "bun", result: { code: 1, stderr: "boom" } }]);
		const res = await createWardenAdapter(deps).run(ctxOf(exec));
		expect(res).toMatchObject({ success: false, error: { kind: "failed" } });
		if (!res.success && res.error.kind === "failed") expect(res.error.message).toContain("boom");
	});
});

describe("prepare / teardown", () => {
	test("prepare warms the helper with a snapshot, teardown closes it", async () => {
		const exec = fakeExec([{ cmd: process.execPath, result: {} }], { which: ["bun"] });
		const adapter = createWardenAdapter(depsOf({}));
		const ctx = ctxOf(exec, { env: { WARDEN_BUN: process.execPath } });
		expect((await adapter.prepare(ctx)).success).toBe(true);
		expect((await adapter.teardown(ctx)).success).toBe(true);
		expect(exec.calls.map((c) => c.args.slice(1, 3).join(" "))).toEqual(["ui snapshot", "ui close"]);
	});

	test("android skips the helper", async () => {
		const exec = fakeExec();
		const ctx = ctxOf(exec, { platform: "android" });
		await createWardenAdapter(depsOf({})).prepare(ctx);
		expect(exec.calls).toHaveLength(0);
	});
});
