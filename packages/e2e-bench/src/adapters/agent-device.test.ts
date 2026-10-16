import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import type { RunContext } from "./adapter.types";
import {
	agentDeviceAdapter,
	agentDeviceEnv,
	agentDevicePids,
	agentDevicePrepareArgv,
	agentDeviceTestArgv,
	createAgentDeviceAdapter,
	defaultAgentDeviceDeps,
	findAttemptDir,
	nativeNameOfCase,
	stateDirOf,
} from "./agent-device";

const packageRoot = join(import.meta.dir, "../..");
const fixtureDir = join(import.meta.dir, "fixtures/agent-device");
const fixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");

function ctxOf(exec: RunContext["exec"], overrides: Partial<RunContext> = {}): RunContext {
	return {
		platform: "ios",
		udid: "U1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/app/Example.app",
		outDir: mkdtempSync(join(tmpdir(), "ad-adapter-")),
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

const HOME = mkdtempSync(join(tmpdir(), "ad-home-"));
const STATE = join(HOME, ".agent-device-bench/agent-device");
const adapter = createAgentDeviceAdapter({ ...defaultAgentDeviceDeps, home: () => HOME });

/** Lays out what `agent-device test` leaves in `--artifacts-dir` for one script. */
function writeAttempt(outDir: string, name: string, attempt: number, timing: string, script: string): void {
	const dir = join(
		outDir,
		"artifacts/abc123",
		`packages__e2e-bench__suites__agent-device__${name}.ad`,
		`attempt-${attempt}`
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "replay-timing.ndjson"), timing);
	writeFileSync(join(dir, "replay.ad"), script);
}

describe("argv", () => {
	test("iOS test pins --udid, never --platform (it would filter out header-less scripts)", () => {
		const argv = agentDeviceTestArgv({
			platform: "ios",
			udid: "U1",
			glob: "/s/*.ad",
			junitPath: "/o/junit.xml",
			artifactsDir: "/o/artifacts",
			retries: 0,
		});
		expect(argv).toEqual([
			"test",
			"/s/*.ad",
			"--udid",
			"U1",
			"--session",
			"bench-U1",
			"--reporter",
			"junit:/o/junit.xml",
			"--artifacts-dir",
			"/o/artifacts",
			"--verbose",
			"--retries",
			"0",
		]);
		expect(argv).not.toContain("--platform");
	});
	test("Android uses --serial and forwards retries", () => {
		const argv = agentDeviceTestArgv({
			platform: "android",
			udid: "emulator-5554",
			glob: "g",
			junitPath: "j",
			artifactsDir: "a",
			retries: 2,
		});
		expect(argv).toContain("--serial");
		expect(argv).not.toContain("--udid");
		expect(argv.slice(-2)).toEqual(["--retries", "2"]);
	});
	test("prepare argv", () => {
		expect(agentDevicePrepareArgv("U1")).toEqual(["prepare", "ios-runner", "--platform", "ios", "--udid", "U1"]);
	});
	test("junit names lose the .ad extension", () => {
		expect(nativeNameOfCase("todo-detail-deep-link.ad")).toBe("todo-detail-deep-link");
	});
});

describe("doctor / prepare / teardown", () => {
	test("doctor reports the version, or the install hint", async () => {
		const ok = await adapter.doctor(ctxOf(fakeExec([{ cmd: "agent-device", result: { stdout: "0.21.20\n" } }])));
		expect(ok).toEqual({ ok: true, version: "agent-device 0.21.20", notes: [] });
		const missing = await adapter.doctor(ctxOf(fakeExec([])));
		expect(missing).toMatchObject({ ok: false, installHint: "bun add -g agent-device" });
	});
	test("prepare warms the iOS runner then stops the daemon without --clean", async () => {
		const exec = fakeExec([{ cmd: "agent-device", result: {} }]);
		const r = await adapter.prepare(ctxOf(exec));
		expect(r.success).toBe(true);
		expect(exec.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["prepare ios-runner", "daemon stop"]);
		expect(exec.calls[1]?.args).not.toContain("--clean");
		expect(exec.calls[1]?.args).toEqual(["daemon", "stop", "--state-dir", STATE]);
	});
	test("prepare does nothing on Android", async () => {
		const exec = fakeExec([]);
		expect((await adapter.prepare(ctxOf(exec, { platform: "android" }))).success).toBe(true);
		expect(exec.calls).toHaveLength(0);
	});
	test("prepare surfaces a failing runner build", async () => {
		const exec = fakeExec([{ cmd: "agent-device", result: { code: 1, stderr: "boom" } }]);
		const r = await adapter.prepare(ctxOf(exec));
		expect(r.success).toBe(false);
	});
	test("teardown stops the daemon with --clean and kills stray daemons", async () => {
		const ps = [
			`  101 /bun/agent-device daemon --state-dir ${STATE}`,
			"  102 /usr/bin/vim",
			"  103 xcodebuild AgentDeviceRunner -destination id=U1",
			"  104 /bun/agent-device daemon --state-dir /Users/other/.agent-device",
			"  105 xcodebuild AgentDeviceRunner -destination id=OTHER-UDID",
		].join("\n");
		const exec = fakeExec([
			{ cmd: "agent-device", result: {} },
			{ cmd: "ps", result: { stdout: ps } },
			{ cmd: "kill", result: {} },
		]);
		expect((await adapter.teardown(ctxOf(exec))).success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["daemon", "stop", "--state-dir", STATE, "--clean"]);
		expect(exec.calls[0]?.options?.env?.AGENT_DEVICE_STATE_DIR).toBe(STATE);
		const killed = exec.calls.filter((c) => c.cmd === "kill").map((c) => c.args[0]);
		expect(killed).toEqual(["101", "103"]);
	});
	test("agentDevicePids ignores itself and unrelated processes", () => {
		expect(agentDevicePids("  5 agent-device daemon U1\n  6 node server U1\n", 5, ["U1"])).toEqual([]);
	});
});

describe("private state dir", () => {
	test("defaults under ~/.agent-device-bench and honours the override", () => {
		expect(stateDirOf({}, "/h")).toBe("/h/.agent-device-bench/agent-device");
		expect(stateDirOf({ BENCH_AGENT_DEVICE_STATE_DIR: "/x" }, "/h")).toBe("/x");
		expect(agentDeviceEnv({ A: "1" }, "/x")).toEqual({ A: "1", AGENT_DEVICE_STATE_DIR: "/x" });
	});
	test("doctor, prepare and run all spawn with it", async () => {
		const exec = fakeExec([{ cmd: "agent-device", result: { stdout: "0.21.20" } }]);
		const ctx = ctxOf(exec);
		await adapter.doctor(ctx);
		await adapter.prepare(ctx);
		await adapter.run(ctx);
		const envs = exec.calls.filter((c) => c.cmd === "agent-device").map((c) => c.options?.env?.AGENT_DEVICE_STATE_DIR);
		expect(envs.length).toBeGreaterThanOrEqual(4);
		expect(envs.every((e) => e === STATE)).toBe(true);
	});
});

describe("findAttemptDir", () => {
	test("picks the highest attempt of the script in the newest run dir", () => {
		const outDir = mkdtempSync(join(tmpdir(), "ad-attempt-"));
		writeAttempt(outDir, "sign-in-field-errors", 1, "", "");
		writeAttempt(outDir, "sign-in-field-errors", 2, "", "");
		const found = findAttemptDir(defaultAgentDeviceDeps, join(outDir, "artifacts"), "sign-in-field-errors");
		expect(found?.endsWith("sign-in-field-errors.ad/attempt-2")).toBe(true);
		expect(findAttemptDir(defaultAgentDeviceDeps, join(outDir, "artifacts"), "nope")).toBeUndefined();
	});
});

describe("run", () => {
	function runWith(xml: string, outDir?: string) {
		const ctx = ctxOf(fakeExec([]), outDir === undefined ? {} : { outDir });
		const exec = fakeExec([
			{
				cmd: "agent-device",
				result: () => {
					writeFileSync(join(ctx.outDir, "junit.xml"), xml);
					return { stdout: "" };
				},
			},
		]);
		return { ctx: { ...ctx, exec }, exec };
	}

	test("maps a passing run onto the 8 canonical ids with steps from the timing file", async () => {
		const { ctx, exec } = runWith(fixture("junit-pass.xml"));
		writeAttempt(
			ctx.outDir,
			"onboarding-steps-to-sign-in",
			1,
			fixture("replay-timing-onboarding.ndjson"),
			fixture("replay-onboarding.ad")
		);
		const r = await adapter.run(ctx);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.tests).toHaveLength(8);
		expect(r.data.tests.every((t) => t.status === "passed")).toBe(true);
		const onboarding = r.data.tests.find((t) => t.id === "onboarding/steps-to-sign-in");
		expect(onboarding).toMatchObject({ nativeName: "onboarding-steps-to-sign-in", durationMs: 4751 });
		expect(onboarding?.steps).toHaveLength(8);
		expect(onboarding?.artifacts?.map((a) => a.kind)).toEqual(["junit", "json"]);
		const call = exec.calls[0];
		expect(call?.cmd).toBe("agent-device");
		expect(call?.args).toContain(join(packageRoot, "suites/agent-device/*.ad"));
		expect(r.data.rawArtifactDir).toBe(ctx.outDir);
		expect(r.data.cold).toBe(true);
	});

	test("failed scripts keep their error message", async () => {
		const { ctx } = runWith(fixture("junit-fail.xml"));
		const r = await adapter.run(ctx);
		expect(r.success).toBe(true);
		if (!r.success) return;
		const t = r.data.tests.find((x) => x.id === "onboarding/steps-to-sign-in");
		expect(t?.status).toBe("failed");
		expect(t?.error).toContain("Replay failed at step 2");
	});

	test("an unmapped script name is a parity breach", async () => {
		const xml = fixture("junit-pass.xml").replace("todo-detail-deep-link.ad", "surprise.ad");
		const r = await adapter.run(runWith(xml).ctx);
		expect(r).toMatchObject({ success: false, error: { kind: "failed" } });
		if (!r.success && r.error.kind === "failed")
			expect(r.error.message).toContain("parity breach: unmapped tests: surprise");
	});

	test("a missing junit file fails with the exit code", async () => {
		const ctx = ctxOf(fakeExec([{ cmd: "agent-device", result: { code: 2, stderr: "No replay tests matched" } }]));
		const r = await adapter.run(ctx);
		expect(r.success).toBe(false);
		if (!r.success && r.error.kind === "failed") expect(r.error.message).toContain("exit 2");
	});

	test("a timeout fails", async () => {
		const ctx = ctxOf(fakeExec([{ cmd: "agent-device", result: { timedOut: true, code: 143 } }]));
		const r = await adapter.run(ctx);
		expect(r.success).toBe(false);
		if (!r.success && r.error.kind === "failed") expect(r.error.message).toContain("timeout");
	});
});

describe("adapter shape", () => {
	test("ids, platforms and residue patterns", () => {
		expect(agentDeviceAdapter.id).toBe("agent-device");
		expect(agentDeviceAdapter.supports).toEqual(["ios", "android"]);
		expect(agentDeviceAdapter.residuePatterns.driverBundleIds).toEqual([
			"com.callstack.agentdevice.runner.uitests.xctrunner",
		]);
		expect(agentDeviceAdapter.residuePatterns.dirs).toEqual(["~/.agent-device-bench/agent-device"]);
		expect(agentDeviceAdapter.residuePatterns.stateDirs).toEqual(["~/.agent-device-bench/agent-device"]);
	});
});
