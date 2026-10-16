import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import type { RunContext } from "./adapter.types";
import {
	createMaestroAdapter,
	defaultMaestroDeps,
	findCommandsJson,
	type MaestroDeps,
	maestroArgv,
	maestroEnv,
	maestroPids,
} from "./maestro";

const packageRoot = join(import.meta.dir, "../..");
const fixtureDir = join(import.meta.dir, "fixtures/maestro");
const fixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");

function ctxOf(exec: RunContext["exec"], overrides: Partial<RunContext> = {}): RunContext {
	return {
		platform: "ios",
		udid: "U1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/app/Example.app",
		outDir: mkdtempSync(join(tmpdir(), "maestro-adapter-")),
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

const argValue = (args: readonly string[], flag: string): string => {
	const i = args.indexOf(flag);
	return args[i + 1] ?? "";
};

describe("argv / env", () => {
	const base = { udid: "U1", suiteDir: "/s", junitPath: "/o/junit.xml", testOutputDir: "/o/out" };
	test("cold rep reinstalls the driver (default), warm rep does not", () => {
		const cold = maestroArgv({ ...base, cold: true });
		expect(cold).toEqual([
			"--udid",
			"U1",
			"test",
			"/s",
			"--format",
			"junit",
			"--output",
			"/o/junit.xml",
			"--test-output-dir",
			"/o/out",
			"--no-ansi",
		]);
		expect(maestroArgv({ ...base, cold: false })).toContain("--no-reinstall-driver");
		expect(cold).not.toContain("--no-reinstall-driver");
	});
	test("env switches analytics off and keeps the caller's env", () => {
		expect(maestroEnv({ FOO: "1" })).toMatchObject({ FOO: "1", MAESTRO_CLI_NO_ANALYTICS: "1" });
	});
});

describe("doctor", () => {
	const java = (code = 0) => ({
		cmd: "java",
		result: { code, stderr: 'openjdk version "21.0.10" 2026-01-20\nOpenJDK Runtime Environment' },
	});
	test("ok with maestro and java versions", async () => {
		const exec = fakeExec([{ cmd: "maestro", result: { stdout: "2.8.0\n" } }, java()]);
		const d = await createMaestroAdapter(defaultMaestroDeps).doctor(ctxOf(exec));
		expect(d).toEqual({ ok: true, version: "maestro 2.8.0", notes: ["java 21.0.10"] });
	});
	test("missing maestro prints the brew hint", async () => {
		const d = await createMaestroAdapter(defaultMaestroDeps).doctor(ctxOf(fakeExec([java()])));
		expect(d).toMatchObject({ ok: false, installHint: "brew install maestro" });
	});
	test("missing java prints the openjdk hint", async () => {
		const exec = fakeExec([{ cmd: "maestro", result: { stdout: "2.8.0\n" } }, java(1)]);
		const d = await createMaestroAdapter(defaultMaestroDeps).doctor(ctxOf(exec));
		expect(d).toMatchObject({ ok: false, installHint: "brew install openjdk@21" });
	});
});

describe("teardown", () => {
	const PS = [
		"  100 /usr/bin/login",
		"  200 /opt/homebrew/opt/openjdk@21/bin/java -Dmaestro.foo -cp maestro.jar maestro.cli.AppKt test",
		"  201 /Xcode/xcodebuild test-without-building -xctestrun maestro-driver-iosUITests.xctestrun",
		"  300 bun test packages/e2e-bench maestro",
		"  400 bun src/cli.ts run --frameworks maestro",
	].join("\n");
	test("pids pick java + driver processes only, never the bench itself", () => {
		expect(maestroPids(PS, 9999)).toEqual([200, 201]);
		expect(maestroPids(PS, 200)).toEqual([201]);
	});
	test("kills the matched pids", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: PS } },
			{ cmd: "kill", result: {} },
		]);
		const r = await createMaestroAdapter(defaultMaestroDeps).teardown(ctxOf(exec));
		expect(r.success).toBe(true);
		expect(exec.calls.filter((c) => c.cmd === "kill").map((c) => c.args[0])).toEqual(["200", "201"]);
	});
});

describe("findCommandsJson", () => {
	test("newest timestamp wins, flat layout is a fallback", () => {
		const files: Record<string, string> = {
			"/r/2026-01-01_000001/a/commands.json": "[]",
			"/r/2026-01-01_000002/a/commands.json": "[]",
			"/r/b/commands.json": "[]",
		};
		const deps: MaestroDeps = {
			readText: (p) => files[p],
			writeText: () => undefined,
			listDir: (d) => (d === "/r" ? ["2026-01-01_000001", "2026-01-01_000002", "b"] : []),
		};
		expect(findCommandsJson(deps, "/r", "a")).toBe("/r/2026-01-01_000002/a/commands.json");
		expect(findCommandsJson(deps, "/r", "b")).toBe("/r/b/commands.json");
		expect(findCommandsJson(deps, "/r", "zzz")).toBeUndefined();
	});
});

describe("run", () => {
	function execWith(junit: string | undefined, extra: Partial<{ code: number; timedOut: boolean }> = {}) {
		const files = new Map<string, string>();
		const deps: MaestroDeps = {
			readText: (p) => files.get(p),
			writeText: (p, t) => void files.set(p, t),
			listDir: (d) =>
				[...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1).split("/")[0] ?? ""),
		};
		const exec = fakeExec([
			{
				cmd: "maestro",
				result: (args) => {
					if (junit !== undefined) files.set(argValue(args, "--output"), junit);
					const out = argValue(args, "--test-output-dir");
					files.set(
						`${out}/2026-10-16_120000/onboarding-steps-to-sign-in/commands.json`,
						fixture("commands-onboarding.json")
					);
					return { code: extra.code ?? 0, stdout: "ran", timedOut: extra.timedOut ?? false };
				},
			},
		]);
		return { exec, deps };
	}

	test("maps junit to canonical results with steps and artifacts", async () => {
		const { exec, deps } = execWith(fixture("junit-pass.xml"));
		const ctx = ctxOf(exec);
		const r = await createMaestroAdapter(deps).run(ctx);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.tests).toHaveLength(8);
		expect(r.data.tests.every((t) => t.status === "passed")).toBe(true);
		expect(r.data.cold).toBe(true);
		expect(r.data.rawArtifactDir).toBe(ctx.outDir);
		const onboarding = r.data.tests.find((t) => t.id === "onboarding/steps-to-sign-in");
		expect(onboarding?.nativeName).toBe("onboarding-steps-to-sign-in");
		expect(onboarding?.durationMs).toBeGreaterThan(1000);
		expect(onboarding?.steps?.length).toBeGreaterThan(5);
		expect(onboarding?.artifacts).toEqual([
			{ kind: "junit", path: "junit.xml" },
			{ kind: "json", path: "maestro-out/2026-10-16_120000/onboarding-steps-to-sign-in/commands.json" },
		]);
		expect(exec.calls[0]?.args).toContain("--udid");
		expect(exec.calls[0]?.args).not.toContain("--no-reinstall-driver");
	});

	test("warm rep skips the driver reinstall", async () => {
		const { exec, deps } = execWith(fixture("junit-pass.xml"));
		await createMaestroAdapter(deps).run(ctxOf(exec, { cold: false }));
		expect(exec.calls[0]?.args).toContain("--no-reinstall-driver");
	});

	test("failed flows keep their message and a non-zero exit is not an adapter error", async () => {
		const { exec, deps } = execWith(fixture("junit-fail.xml"), { code: 1 });
		const r = await createMaestroAdapter(deps).run(ctxOf(exec));
		expect(r.success).toBe(true);
		if (!r.success) return;
		const t = r.data.tests.find((x) => x.id === "sign-in/valid-credentials");
		expect(t?.status).toBe("failed");
		expect(t?.error).toContain("1 left");
		expect(r.data.tests.filter((x) => x.status === "failed")).toHaveLength(4);
	});

	test("unmapped flow name is a parity breach; missing flow is reported missing", async () => {
		const xml = '<testsuites><testsuite><testcase name="mystery" time="1"/></testsuite></testsuites>';
		const { exec, deps } = execWith(xml);
		const r = await createMaestroAdapter(deps).run(ctxOf(exec));
		expect(r).toEqual({ success: false, error: { kind: "failed", message: "parity breach: unmapped tests: mystery" } });

		const one = '<testsuites><testsuite><testcase name="todo-detail-deep-link" time="2"/></testsuite></testsuites>';
		const second = execWith(one);
		const r2 = await createMaestroAdapter(second.deps).run(ctxOf(second.exec));
		expect(r2.success).toBe(true);
		if (!r2.success) return;
		expect(r2.data.tests.filter((t) => t.status === "missing")).toHaveLength(7);
	});

	test("no junit, timeout and spawn error are failed", async () => {
		const none = execWith(undefined, { code: 2 });
		const a = await createMaestroAdapter(none.deps).run(ctxOf(none.exec));
		expect(a.success).toBe(false);
		const slow = execWith(undefined, { timedOut: true });
		const b = await createMaestroAdapter(slow.deps).run(ctxOf(slow.exec));
		expect(b).toMatchObject({ success: false, error: { kind: "failed" } });
		const missing = fakeExec([]);
		const c = await createMaestroAdapter(defaultMaestroDeps).run(ctxOf(missing));
		expect(c.success).toBe(false);
	});
});
