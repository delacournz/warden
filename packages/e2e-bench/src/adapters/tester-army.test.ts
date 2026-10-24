import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeRule, fakeExec } from "../harness/exec";
import { CANONICAL_IDS } from "../results/schema";
import type { RunContext } from "./adapter.types";
import {
	createTesterArmyAdapter,
	nodeBinDir,
	nodePath,
	nodeTooOld,
	packageVersion,
	stateDirOf,
	type TesterArmyDeps,
	testerArmyArgv,
	testerArmyEnv,
} from "./tester-army";

const packageRoot = join(import.meta.dir, "../..");
const TITLES = [
	"onboarding steps through to sign-in",
	"invalid email and short password show field errors",
	"a locked account shows the form alert",
	"valid credentials land on todos",
	"add, complete and filter todos",
	"open a todo, mark it done, then delete it",
	"deep link opens a todo by id",
	"settings shows the account, toggles switches and signs out",
];

const reportOf = (titles: readonly string[], status = "passed"): string =>
	JSON.stringify({
		schemaVersion: "report-1",
		run: {
			results: titles.map((title, i) => ({
				kind: "test",
				titlePath: [title],
				status,
				attempts: [{ status, durationMs: 1000 + i, steps: [] }],
			})),
		},
	});

type Files = Record<string, string>;
const depsOf = (files: Files, nvm: string[] = ["v22.1.0", "v24.19.0", "v24.9.0", "v18.0.0"]): TesterArmyDeps => ({
	exists: (p) => p in files,
	readText: (p) => files[p],
	home: () => "/home/u",
	nvmVersions: () => nvm,
});

const ctxOf = (rules: FakeRule[], env: RunContext["env"] = { PATH: "/usr/bin" }) => {
	const exec = fakeExec(rules);
	const lines: string[] = [];
	const ctx: RunContext = {
		platform: "ios",
		udid: "UDID-1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/app",
		outDir: "/out/rep-1",
		cold: true,
		retries: 0,
		env,
		exec,
		log: (l) => lines.push(l),
		packageRoot,
		repoRoot: "/repo",
	};
	return { ctx, exec, lines };
};

const nodeRule = (okPathVersion: string, pinnedVersion = "v24.19.0"): FakeRule => ({
	cmd: "node",
	result: (_args, options) => ({
		stdout: `${options?.env?.PATH?.startsWith("/home/u/.nvm") ? pinnedVersion : okPathVersion}\n`,
	}),
});

describe("nodeTooOld", () => {
	test("accepts ^22.22.3 and >=24.8.0 only", () => {
		const cases: Array<[string, boolean]> = [
			["v22.22.2", true],
			["v22.22.3", false],
			["v22.23.0", false],
			["v22.12.0", true],
			["v23.9.0", true],
			["v24.7.9", true],
			["v24.8.0", false],
			["v24.19.0", false],
			["v25.0.0", false],
			["v20.18.0", true],
			["garbage", true],
		];
		expect(cases.map(([v]) => nodeTooOld(v))).toEqual(cases.map(([, tooOld]) => tooOld));
	});
});

describe("node path helpers", () => {
	test("BENCH_NODE_BIN wins, else the newest nvm Node that satisfies the range", () => {
		const deps = depsOf({});
		expect(nodeBinDir({ BENCH_NODE_BIN: "/n/bin" }, deps)).toBe("/n/bin");
		expect(nodeBinDir({}, deps)).toBe("/home/u/.nvm/versions/node/v24.19.0/bin");
	});

	test("no override and no usable nvm Node gives undefined, not a made-up path", () => {
		expect(nodeBinDir({}, depsOf({}, ["v22.1.0", "junk"]))).toBeUndefined();
		expect(nodeBinDir({}, depsOf({}, []))).toBeUndefined();
	});

	test("nodePath prepends to PATH, or stands alone without one", () => {
		expect(nodePath({ PATH: "/usr/bin:/bin" }, "/n/bin")).toBe("/n/bin:/usr/bin:/bin");
		expect(nodePath({}, "/n/bin")).toBe("/n/bin");
	});
});

describe("argv and env", () => {
	test("list + junit reporters into the suite-local output dir, retries forwarded", () => {
		expect(testerArmyArgv({ retries: 1 })).toEqual([
			"e2e",
			"run",
			"--reporter",
			"list,junit",
			"--output",
			".bench-out",
			"--retries",
			"1",
		]);
	});

	test("state dir: BENCH_TESTER_ARMY_STATE_DIR, else a private dir under home", () => {
		expect(stateDirOf({ BENCH_TESTER_ARMY_STATE_DIR: "/s" }, "/home/u")).toBe("/s");
		expect(stateDirOf({}, "/home/u")).toBe("/home/u/.agent-device-bench/tester-army");
	});

	test("env carries the device, platform and the private agent-device state dir", () => {
		const { ctx } = ctxOf([]);
		expect(testerArmyEnv(ctx, "/p", "/s")).toMatchObject({
			PATH: "/p",
			BENCH_UDID: "UDID-1",
			BENCH_PLATFORM: "ios",
			AGENT_DEVICE_STATE_DIR: "/s",
		});
	});
});

describe("packageVersion", () => {
	test("walks up to the hoisted node_modules", () => {
		const deps = depsOf({ "/repo/node_modules/e2e/package.json": '{"version":"0.20.0"}' });
		expect(packageVersion(deps, "/repo/packages/e2e-bench", "e2e")).toBe("0.20.0");
		expect(packageVersion(deps, "/repo/packages/e2e-bench", "nope")).toBeUndefined();
	});
});

describe("doctor", () => {
	const files: Files = {
		[join(packageRoot, "node_modules/e2e/package.json")]: '{"version":"0.20.0"}',
		[join(packageRoot, "node_modules/@e2e-dev/mobile/package.json")]: '{"version":"0.12.0"}',
		[join(packageRoot, "node_modules/agent-device/package.json")]: '{"version":"0.21.25"}',
	};

	test("ok with the default Node when it is new enough", async () => {
		const { ctx } = ctxOf([nodeRule("v24.9.0")]);
		const doctor = await createTesterArmyAdapter(depsOf(files)).doctor(ctx);
		expect(doctor).toEqual({
			ok: true,
			version: "e2e 0.20.0",
			notes: ["@e2e-dev/mobile 0.12.0", "bundled agent-device 0.21.25", "node v24.9.0"],
		});
	});

	test("falls back to the pinned Node and says so", async () => {
		const { ctx } = ctxOf([nodeRule("v22.22.2")]);
		const doctor = await createTesterArmyAdapter(depsOf(files)).doctor(ctx);
		expect(doctor.ok && doctor.notes.at(-1)).toContain("v24.19.0 (pinned, /home/u/.nvm/versions/node/v24.19.0/bin)");
	});

	test("not ok with a clear reason when there is no override and no nvm Node", async () => {
		const { ctx } = ctxOf([nodeRule("v22.22.2")]);
		const doctor = await createTesterArmyAdapter(depsOf(files, [])).doctor(ctx);
		expect(doctor).toMatchObject({ ok: false, reason: expect.stringContaining("BENCH_NODE_BIN is unset") });
	});

	test("not ok with an install hint when no Node is new enough", async () => {
		const { ctx } = ctxOf([nodeRule("v22.22.2", "v22.22.2")]);
		const doctor = await createTesterArmyAdapter(depsOf(files)).doctor(ctx);
		expect(doctor).toMatchObject({ ok: false, installHint: expect.stringContaining("nvm install 24") });
	});

	test("not ok when e2e is not installed", async () => {
		const { ctx } = ctxOf([nodeRule("v24.9.0")]);
		const doctor = await createTesterArmyAdapter(depsOf({})).doctor(ctx);
		expect(doctor).toMatchObject({ ok: false, installHint: "bun install" });
	});
});

describe("run", () => {
	const reportPath = "/out/rep-1/report/report.json";
	const fileOps: FakeRule[] = [
		{ cmd: "rm", result: { code: 0 } },
		{ cmd: "mkdir", result: { code: 0 } },
		{ cmd: "cp", result: { code: 0 } },
	];

	test("runs bunx e2e from the suite dir on the pinned Node and maps all 8 tests", async () => {
		const { ctx, exec, lines } = ctxOf([nodeRule("v22.22.2"), { cmd: "bunx", result: { code: 0 } }, ...fileOps]);
		const adapter = createTesterArmyAdapter(
			depsOf({ [reportPath]: reportOf(TITLES), "/out/rep-1/report/junit.xml": "<x/>" })
		);
		const result = await adapter.run(ctx);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.tests.map((t) => t.id)).toEqual([...CANONICAL_IDS]);
		expect(result.data.tests.map((t) => t.durationMs)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
		expect(result.data.cold).toBe(true);
		expect(result.data.rawArtifactDir).toBe("/out/rep-1");
		expect(result.data.tests[0]?.artifacts).toEqual([
			{ kind: "json", path: "report/report.json" },
			{ kind: "junit", path: "report/junit.xml" },
		]);
		const call = exec.calls.find((c) => c.cmd === "bunx");
		expect(call?.options?.cwd).toBe(join(packageRoot, "suites/tester-army"));
		expect(call?.options?.env?.PATH).toBe("/home/u/.nvm/versions/node/v24.19.0/bin:/usr/bin");
		expect(call?.options?.env?.BENCH_UDID).toBe("UDID-1");
		expect(call?.options?.env?.AGENT_DEVICE_STATE_DIR).toBe("/home/u/.agent-device-bench/tester-army");
		const suiteOut = join(packageRoot, "suites/tester-army/.bench-out");
		expect(exec.calls.filter((c) => c.cmd !== "node" && c.cmd !== "bunx").map((c) => [c.cmd, ...c.args])).toEqual([
			["rm", "-rf", suiteOut],
			["mkdir", "-p", "/out/rep-1/report"],
			["cp", "-R", `${suiteOut}/.`, "/out/rep-1/report"],
			["rm", "-rf", suiteOut],
		]);
		expect(call?.options?.timeoutMs).toBe(20 * 60_000);
		expect(lines[0]).toContain("pinned");
	});

	test("the real report fixture maps every test, durations as reported", async () => {
		const real = readFileSync(join(import.meta.dir, "fixtures/tester-army/report.json"), "utf8");
		const { ctx } = ctxOf([nodeRule("v24.9.0"), { cmd: "bunx", result: { code: 0 } }, ...fileOps]);
		const result = await createTesterArmyAdapter(depsOf({ [reportPath]: real })).run(ctx);
		expect(result.success && result.data.tests.map((t) => [t.id, t.status, t.durationMs])).toEqual([
			["onboarding/steps-to-sign-in", "passed", 7553],
			["sign-in/field-errors", "passed", 22713],
			["sign-in/locked-account", "passed", 14451],
			["sign-in/valid-credentials", "passed", 16780],
			["todos/add-complete-filter", "passed", 25721],
			["todo-detail/open-toggle-delete", "passed", 20265],
			["todo-detail/deep-link", "passed", 23199],
			["settings/account-switches-sign-out", "passed", 21327],
		]);
	});

	test("failed tests are results, not an adapter error", async () => {
		const { ctx } = ctxOf([nodeRule("v24.9.0"), { cmd: "bunx", result: { code: 1 } }, ...fileOps]);
		const adapter = createTesterArmyAdapter(depsOf({ [reportPath]: reportOf(TITLES, "failed") }));
		const result = await adapter.run(ctx);
		expect(result.success && result.data.tests.every((t) => t.status === "failed")).toBe(true);
	});

	test("a test missing from the report is `missing`", async () => {
		const { ctx } = ctxOf([nodeRule("v24.9.0"), { cmd: "bunx", result: { code: 1 } }, ...fileOps]);
		const adapter = createTesterArmyAdapter(depsOf({ [reportPath]: reportOf(TITLES.slice(0, 7)) }));
		const result = await adapter.run(ctx);
		expect(result.success && result.data.tests.at(-1)).toMatchObject({
			id: "settings/account-switches-sign-out",
			status: "missing",
		});
	});

	test("an unmapped native name is a parity breach", async () => {
		const { ctx } = ctxOf([nodeRule("v24.9.0"), { cmd: "bunx", result: { code: 0 } }, ...fileOps]);
		const adapter = createTesterArmyAdapter(depsOf({ [reportPath]: reportOf([...TITLES, "surprise"]) }));
		const result = await adapter.run(ctx);
		expect(result).toEqual({
			success: false,
			error: { kind: "failed", message: "parity breach: unmapped tests: surprise" },
		});
	});

	test("no report.json: failed with the exit code and stderr tail", async () => {
		const { ctx } = ctxOf([
			nodeRule("v24.9.0"),
			{ cmd: "bunx", result: { code: 2, stderr: "bad config" } },
			...fileOps,
		]);
		const result = await createTesterArmyAdapter(depsOf({})).run(ctx);
		expect(result).toEqual({
			success: false,
			error: { kind: "failed", message: "tester.army wrote no report.json (exit 2): bad config" },
		});
	});

	test("no usable Node: failed before spawning bunx", async () => {
		const { ctx, exec } = ctxOf([nodeRule("v22.22.2", "v22.22.2")]);
		const result = await createTesterArmyAdapter(depsOf({})).run(ctx);
		expect(result.success).toBe(false);
		expect(exec.calls.some((c) => c.cmd === "bunx")).toBe(false);
	});
});

describe("prepare / teardown", () => {
	test("prepare does nothing", async () => {
		const { ctx, exec } = ctxOf([]);
		expect(await createTesterArmyAdapter(depsOf({})).prepare(ctx)).toEqual({ success: true, data: undefined });
		expect(exec.calls).toEqual([]);
	});

	test("teardown stops the bundled daemon with --clean, then kills leftovers of this checkout", async () => {
		const { ctx, exec } = ctxOf([
			nodeRule("v24.9.0"),
			{ cmd: "bunx", result: { code: 0 } },
			{ cmd: "pkill", result: { code: 1 } },
		]);
		const result = await createTesterArmyAdapter(depsOf({})).teardown(ctx);
		expect(result.success).toBe(true);
		const bunx = exec.calls.find((c) => c.cmd === "bunx");
		expect(bunx?.args).toEqual([
			"agent-device",
			"daemon",
			"stop",
			"--state-dir",
			"/home/u/.agent-device-bench/tester-army",
			"--clean",
		]);
		expect(bunx?.options?.cwd).toBe(join(packageRoot, "suites/tester-army"));
		expect(exec.calls.find((c) => c.cmd === "pkill")?.args).toEqual(["-f", "/repo/node_modules/agent-device"]);
	});
});

describe("residue patterns", () => {
	test("agent-device and e2e-dev processes, their state dirs", () => {
		const { residuePatterns } = createTesterArmyAdapter(depsOf({}));
		expect(residuePatterns.processes.some((p) => p.test("node /x/node_modules/agent-device/dist/daemon.js"))).toBe(
			true
		);
		expect(residuePatterns.dirs).toEqual(["~/.agent-device-bench/tester-army", "~/.e2e"]);
	});
});
