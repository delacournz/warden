import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import type { RunContext } from "./adapter.types";
import {
	APPLESIMUTILS_HINT,
	classifyDetoxFailure,
	createDetoxAdapter,
	DETOX_ANDROID_REASON,
	type DetoxDeps,
	detoxArgv,
	detoxEnv,
	detoxPids,
} from "./detox";

const packageRoot = join(import.meta.dir, "../..");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/detox", name), "utf8");
const BIN = "/repo/node_modules/.bin/detox";

function ctxOf(exec: RunContext["exec"], overrides: Partial<RunContext> = {}): RunContext {
	return {
		platform: "ios",
		udid: "U1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/app/Example.app",
		outDir: "/out",
		cold: true,
		retries: 0,
		env: {},
		exec,
		log: () => undefined,
		packageRoot,
		repoRoot: "/repo",
		...overrides,
	};
}

function depsOf(files: Record<string, string>): DetoxDeps & { written: string[] } {
	const written: string[] = [];
	return {
		written,
		exists: (p) => p in files,
		readText: (p) => files[p],
		writeText: (p) => {
			written.push(p);
		},
	};
}

describe("argv / env", () => {
	test("argv forwards retries only when > 0 and passes jest's json flags", () => {
		expect(detoxArgv({ retries: 0, jsonPath: "/o/jest.json" })).toEqual([
			"test",
			"-c",
			"ios.sim.release",
			"--json",
			"--outputFile",
			"/o/jest.json",
		]);
		expect(detoxArgv({ retries: 2, jsonPath: "/j" })).toContain("--retries");
	});

	test("env carries the bench contract", () => {
		const env = detoxEnv({ appPath: "/a", udid: "U", outDir: "/o", env: { X: "1" } });
		expect(env).toMatchObject({ X: "1", BENCH_APP_PATH: "/a", BENCH_UDID: "U", BENCH_OUT: "/o/detox-artifacts" });
	});
});

describe("classifyDetoxFailure", () => {
	test.each([
		"Error: The app has not responded to the network requests below",
		"DetoxRuntimeError: Detox can't seem to connect to the test app(s)!",
		"Failed to run application on the device",
		"detox[1] ERROR: applesimutils not found",
		"Waiting for synchronization to finish",
	])("%s is unsupported", (line) => {
		expect(classifyDetoxFailure(`ok\n${line}\nmore`)).toContain(line.slice(0, 20));
	});

	test("an ordinary assertion failure is not", () => {
		expect(classifyDetoxFailure('Expected: "1 left"\nReceived: "2 left"')).toBeUndefined();
	});
});

describe("detoxPids", () => {
	test("picks detox / DetoxServer / jest-runner lines, never the bench itself", () => {
		const ps = [
			" 100 /usr/bin/node /repo/node_modules/detox/local-cli/cli.js test -c ios.sim.release",
			" 101 /repo/node_modules/detox/runners/jest/index.js",
			" 102 /usr/bin/vim notes.txt",
			" 103 bun test src/adapters/detox.test.ts detox test",
			" 104 xcodebuild -project Detox.xcodeproj",
		].join("\n");
		expect(detoxPids(ps, 999)).toEqual([100, 101, 104]);
		expect(detoxPids(ps, 100)).not.toContain(100);
	});
});

describe("doctor", () => {
	test("missing applesimutils is not ok and prints the brew hint", async () => {
		const exec = fakeExec([{ cmd: BIN, result: { stdout: "20.51.3\n" } }]);
		const d = await createDetoxAdapter(depsOf({})).doctor(ctxOf(exec));
		expect(d).toMatchObject({ ok: false, installHint: APPLESIMUTILS_HINT });
	});

	test("ok with applesimutils on PATH", async () => {
		const exec = fakeExec([{ cmd: BIN, result: { stdout: "20.51.3\n" } }], { which: ["applesimutils"] });
		const d = await createDetoxAdapter(depsOf({})).doctor(ctxOf(exec));
		expect(d).toMatchObject({ ok: true, version: "detox 20.51.3" });
	});
});

describe("run", () => {
	test("android is unsupported without BENCH_DETOX_ANDROID", async () => {
		const r = await createDetoxAdapter(depsOf({})).run(ctxOf(fakeExec(), { platform: "android" }));
		expect(r).toEqual({ success: false, error: { kind: "unsupported", reason: DETOX_ANDROID_REASON } });
	});

	test("all eight passing → canonical results", async () => {
		const exec = fakeExec([{ cmd: BIN, result: { code: 0 } }]);
		const deps = depsOf({ "/out/jest.json": fixture("jest-all-pass.json") });
		const r = await createDetoxAdapter(deps).run(ctxOf(exec));
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.tests).toHaveLength(8);
		expect(r.data.tests.every((t) => t.status === "passed")).toBe(true);
		expect(exec.calls[0]?.options?.cwd).toEndWith("suites/detox");
		expect(exec.calls[0]?.options?.env?.BENCH_UDID).toBe("U1");
	});

	test("a test the run never reported is missing; an unknown name is a parity breach", async () => {
		const partial = depsOf({ "/out/jest.json": fixture("jest-pass.json") });
		const r1 = await createDetoxAdapter(partial).run(ctxOf(fakeExec([{ cmd: BIN, result: {} }])));
		expect(r1.success && r1.data.tests.filter((t) => t.status === "missing")).toHaveLength(5);
		const odd = JSON.stringify({ testResults: [{ assertionResults: [{ title: "mystery", status: "passed" }] }] });
		const r2 = await createDetoxAdapter(depsOf({ "/out/jest.json": odd })).run(
			ctxOf(fakeExec([{ cmd: BIN, result: {} }]))
		);
		expect(r2).toMatchObject({ success: false, error: { kind: "failed" } });
	});

	test("a failing assertion stays failed, with its message", async () => {
		const deps = depsOf({ "/out/jest.json": fixture("jest-pass.json") });
		const r = await createDetoxAdapter(deps).run(ctxOf(fakeExec([{ cmd: BIN, result: { code: 1 } }])));
		expect(r.success).toBe(true);
		if (!r.success) return;
		const t = r.data.tests.find((x) => x.id === "sign-in/valid-credentials");
		expect(t?.status).toBe("failed");
		expect(t?.error).toContain("toHaveText");
	});

	test("no json + attach error on stderr → unsupported", async () => {
		const exec = fakeExec([
			{ cmd: BIN, result: { code: 1, stderr: "DetoxRuntimeError: Detox can't seem to connect to the test app(s)!" } },
		]);
		const r = await createDetoxAdapter(depsOf({})).run(ctxOf(exec));
		expect(r).toMatchObject({ success: false, error: { kind: "unsupported" } });
	});

	test("no json + unknown error → failed", async () => {
		const exec = fakeExec([{ cmd: BIN, result: { code: 1, stderr: "boom" } }]);
		const r = await createDetoxAdapter(depsOf({})).run(ctxOf(exec));
		expect(r).toMatchObject({ success: false, error: { kind: "failed" } });
	});

	test("real run without applesimutils: jest json is a file-level crash → unsupported naming applesimutils", async () => {
		const deps = depsOf({ "/out/jest.json": fixture("jest-no-applesimutils.json") });
		const r = await createDetoxAdapter(deps).run(ctxOf(fakeExec([{ cmd: BIN, result: { code: 1 } }])));
		expect(r).toMatchObject({ success: false, error: { kind: "unsupported" } });
		if (!r.success && r.error.kind === "unsupported") expect(r.error.reason).toContain("applesimutils");
	});

	test("real run on RN 0.86: app disconnects from the Detox server → unsupported", async () => {
		const deps = depsOf({ "/out/jest.json": fixture("jest-disconnected.json") });
		const r = await createDetoxAdapter(deps).run(ctxOf(fakeExec([{ cmd: BIN, result: { code: 1 } }])));
		expect(r).toMatchObject({ success: false, error: { kind: "unsupported" } });
		if (!r.success && r.error.kind === "unsupported") expect(r.error.reason).toContain("disconnected");
	});

	test("job timeout → unsupported", async () => {
		const exec = fakeExec([{ cmd: BIN, result: { code: 143, timedOut: true } }]);
		const r = await createDetoxAdapter(depsOf({})).run(ctxOf(exec));
		expect(r).toMatchObject({ success: false, error: { kind: "unsupported" } });
	});

	test("jest json whose failures are attach errors → unsupported", async () => {
		const json = JSON.stringify({
			testResults: [
				{
					assertionResults: [
						{
							title: "onboarding steps through to sign-in",
							status: "failed",
							failureMessages: ["Error: The app has not responded to the network requests below"],
						},
					],
				},
			],
		});
		const r = await createDetoxAdapter(depsOf({ "/out/jest.json": json })).run(
			ctxOf(fakeExec([{ cmd: BIN, result: { code: 1 } }]))
		);
		expect(r).toMatchObject({ success: false, error: { kind: "unsupported" } });
	});
});
