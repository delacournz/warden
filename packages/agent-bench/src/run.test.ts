import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFingerprint } from "@delacour/warden-e2e-bench/src/harness/app";
import { type FakeRule, fakeExec } from "@delacour/warden-e2e-bench/src/harness/exec";
import type { KitDeps, ToolId } from "./kit";
import { type RanReport, reportSchema, type ToolReport } from "./report";
import { claudeArgs, type RunDeps, runAgentBench, runIdFor, selectTools } from "./run";
import type { LoadedSuite } from "./suite";
import { suiteSchema } from "./suite.schema";

const AUTH = { CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/usr/bin" };
const NOW = new Date("2026-11-09T10:15:00.000Z");
const RUN_ID = "agent-login-20261109T101500Z";

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "agent-bench-repo-"));
	const appDir = join(root, ".bench", "app", "ios");
	mkdirSync(join(appDir, "Example.app"), { recursive: true });
	writeFileSync(join(appDir, "Example.app", "Info.plist"), "plist");
	const print = appFingerprint(join(appDir, "Example.app"));
	if (!print.success) throw new Error("fingerprint");
	writeFileSync(
		join(appDir, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			platform: "ios",
			bundleId: "nz.co.delacour.warden.example",
			artifact: "Example.app",
			hash: "h",
			sha256: print.data.sha256,
			bytes: print.data.bytes,
			source: "build",
			builtAt: NOW.toISOString(),
		})
	);
	const skill = join(root, "skills", "warden");
	mkdirSync(join(skill, "rules"), { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "skill");
	writeFileSync(join(skill, "rules", "warden.md"), "rule");
	return root;
}

function pkg(version: string, withArgentFiles = false): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-bench-pkg-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
	if (withArgentFiles) {
		mkdirSync(join(dir, "skills", "argent-device-interact"), { recursive: true });
		writeFileSync(join(dir, "skills", "argent-device-interact", "SKILL.md"), "s");
		mkdirSync(join(dir, "rules"), { recursive: true });
		writeFileSync(join(dir, "rules", "argent.md"), "r");
	}
	return dir;
}

/** argent and agent-device "installed" (or not) for the kits; warden always comes from the checkout. */
function kitDeps(installed: readonly ToolId[] = ["argent", "agent-device"]): KitDeps {
	const roots: Record<string, string> = {
		"/g/argent": pkg("0.27.0", true),
		"/g/agent-device": pkg("0.21.20"),
	};
	return {
		which: (cmd) => (installed.some((t) => t === cmd) ? `/g/${cmd}` : undefined),
		packageRootOf: (bin) => roots[bin],
		readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
		exists: existsSync,
		env: {},
		home: () => "/home/u",
	};
}

function loaded(overrides: Record<string, unknown> = {}): LoadedSuite {
	const suite = suiteSchema.parse({
		name: "login",
		description: "d",
		prompt: "login.md",
		maxTurns: 5,
		baseline: { warden: { toolCalls: 2, driverCalls: 2, stumbles: 0, wallMs: 1000 } },
		success: [{ wait: "id=settings-screen" }],
		...overrides,
	});
	return { suite, path: "/s/login.yml", promptTemplate: "Task: sign in on {{bundleId}}." };
}

const ev = (v: unknown): string => JSON.stringify(v);
const use = (id: string, name: string, input: Record<string, unknown>): string =>
	ev({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const bash = (id: string, command: string): string => use(id, "Bash", { command });
const res = (id: string, content: string): string =>
	ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const done = ev({
	type: "result",
	subtype: "success",
	is_error: false,
	num_turns: 3,
	total_cost_usd: 0.1,
	duration_ms: 9,
});

/** The tool a `claude` argv belongs to, from its `--allowedTools`. */
function toolOf(args: readonly string[]): ToolId {
	if (args.includes("mcp__argent")) return "argent";
	if (args.includes("Bash(agent-device *)")) return "agent-device";
	return "warden";
}

const TRANSCRIPTS: Record<ToolId, string[]> = {
	warden: [
		ev({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
		bash("a", "warden ui snapshot -i --udid SIM-1"),
		res("a", "@e1 [button]"),
		bash("b", "warden ui press @e1 --udid SIM-1"),
		res("b", "stale_ref"),
		done,
	],
	argent: [
		use("a", "mcp__argent__describe", { udid: "SIM-1" }),
		res("a", "tree"),
		use("b", "mcp__argent__gesture-tap", { udid: "SIM-1", x: 0.5, y: 0.5 }),
		res("b", "ok"),
		done,
	],
	"agent-device": [
		bash("a", "agent-device open nz.co.delacour.warden.example --udid SIM-1 --foreground"),
		res("a", "@e2 [button]"),
		bash("b", "agent-device press @e2 --settle --udid SIM-1"),
		res("b", "ELEMENT_NOT_FOUND"),
		done,
	],
};

type Opts = { checkCode?: number; claude?: FakeRule["result"] };

function rules(opts: Opts = {}): FakeRule[] {
	const bun = process.execPath;
	const is = (verb: string) => (a: readonly string[]) => a[1] === verb;
	const ui = (verb: string) => (a: readonly string[]) => a[1] === "ui" && a[2] === verb;
	return [
		{
			cmd: bun,
			match: is("claim"),
			result: { stdout: ev({ leases: [{ leaseId: "L1", udid: "SIM-1", name: "iPhone" }], udids: ["SIM-1"] }) },
		},
		{ cmd: bun, match: is("release"), result: { code: 0 } },
		{ cmd: bun, match: is("heartbeat"), result: { code: 0 } },
		{ cmd: bun, match: ui("wait"), result: { code: opts.checkCode ?? 0 } },
		{ cmd: bun, match: ui("close"), result: { code: 0 } },
		{ cmd: bun, match: ui("snapshot"), result: { code: 0 } },
		{ cmd: "xcrun", result: { code: 0 } },
		{ cmd: "argent", result: { code: 0, stdout: "0.27.0" } },
		{ cmd: "agent-device", result: { code: 0, stdout: "0.21.20" } },
		{
			cmd: "claude",
			result: opts.claude ?? ((args) => ({ code: 0, stdout: TRANSCRIPTS[toolOf(args)].join("\n"), durationMs: 4200 })),
		},
	];
}

function deps(exec: ReturnType<typeof fakeExec>, over: Partial<RunDeps> = {}) {
	const lines: string[] = [];
	const d: RunDeps = {
		exec,
		env: AUTH,
		now: () => NOW,
		log: (l: string) => lines.push(l),
		bunPath: process.execPath,
		heartbeatMs: 1e9,
		kitDeps: kitDeps(),
		sleep: async () => {},
		...over,
	};
	return { lines, deps: d };
}

const ranOf = (tools: readonly ToolReport[], id: ToolId): RanReport => {
	const t = tools.find((x) => x.tool === id);
	if (t === undefined || !t.ran) throw new Error(`${id} did not run`);
	return t;
};

describe("runIdFor", () => {
	test("compact UTC stamp", () => {
		expect(runIdFor("login", NOW)).toBe(RUN_ID);
	});
});

describe("selectTools", () => {
	test("--tools narrows the suite's tools and keeps the suite's order", () => {
		expect(selectTools(["warden", "argent", "agent-device"], undefined)).toEqual(["warden", "argent", "agent-device"]);
		expect(selectTools(["warden", "argent", "agent-device"], ["agent-device", "warden"])).toEqual([
			"warden",
			"agent-device",
		]);
	});
});

describe("claudeArgs", () => {
	test("stream-json, model, the kit's tools, no user setup, budget only when set", () => {
		const s = loaded({ maxBudgetUsd: 2 }).suite;
		const args = claudeArgs("P", s, "m", { allowedTools: ["Bash(warden *)", "Skill"] });
		expect(args.slice(0, 2)).toEqual(["-p", "P"]);
		expect(args).toContain("stream-json");
		expect(args).toContain("--verbose");
		expect(args.join(" ")).toContain("--allowedTools Bash(warden *) Skill --permission-mode dontAsk");
		expect(args.join(" ")).toContain("--strict-mcp-config --setting-sources user");
		expect(args).not.toContain("--mcp-config");
		expect(args.join(" ")).toContain("--max-budget-usd 2");
		expect(claudeArgs("P", loaded().suite, "m", { allowedTools: ["x"] })).not.toContain("--max-budget-usd");
	});

	test("an MCP kit passes its config, still strict", () => {
		const args = claudeArgs("P", loaded().suite, "m", { allowedTools: ["mcp__argent"], mcpConfigPath: "/s/mcp.json" });
		expect(args.join(" ")).toContain("--mcp-config /s/mcp.json --strict-mcp-config");
	});
});

describe("runAgentBench", () => {
	test("runs warden, argent and agent-device on one claimed device and compares them", async () => {
		const root = repo();
		const exec = fakeExec(rules());
		const { deps: d, lines } = deps(exec);
		const out = await runAgentBench({ loaded: loaded(), repoRoot: root }, d);
		if (!out.success) throw new Error(String(out.error));
		const { report, runDir } = out.data;
		expect(runDir).toBe(join(root, ".bench", RUN_ID));
		expect(report.reportVersion).toBe(3);
		expect(report.reps).toBe(1);
		expect(report.udid).toBe("SIM-1");
		expect(report.tools.map((t) => `${t.tool}:${t.outcome}`)).toEqual([
			"warden:passed",
			"argent:passed",
			"agent-device:passed",
		]);

		const warden = ranOf(report.tools, "warden");
		expect(warden.wallMs).toBe(4200);
		expect(warden.metrics.driverCalls).toBe(2);
		expect(warden.metrics.errorCodes).toEqual({ stale_ref: 1 });
		expect(warden.diff?.find((r) => r.metric === "stumbles")?.actual).toBe(1);
		const argent = ranOf(report.tools, "argent");
		expect(argent.version).toBe("0.27.0");
		expect(argent.metrics.driverVerbs).toEqual({ describe: 1, "gesture-tap": 1 });
		expect(argent.diff).toBeUndefined();
		const agentDevice = ranOf(report.tools, "agent-device");
		expect(agentDevice.metrics.driverVerbs).toEqual({ open: 1, press: 1 });
		expect(agentDevice.metrics.errorCodes).toEqual({ ELEMENT_NOT_FOUND: 1 });

		expect(reportSchema.parse(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).runId).toBe(RUN_ID);
		const md = readFileSync(join(runDir, "report.md"), "utf8");
		expect(md).toContain("# agent bench: login — all passed");
		expect(md).toContain("| | warden | argent | agent-device |");
		expect(md.trimEnd().split("\n").at(-1)).toContain("Checks run through `warden ui`");

		for (const tool of ["warden", "argent", "agent-device"] as const) {
			expect(readFileSync(join(runDir, tool, "prompt.md"), "utf8")).toContain(
				"Task: sign in on nz.co.delacour.warden.example."
			);
			expect(existsSync(join(runDir, tool, "transcript.ndjson"))).toBe(true);
		}
		expect(readFileSync(join(runDir, "warden", "prompt.md"), "utf8")).toContain("`warden` CLI");
		expect(readFileSync(join(runDir, "argent", "prompt.md"), "utf8")).toContain("argent MCP tools");
		expect(readFileSync(join(runDir, "agent-device", "prompt.md"), "utf8")).toContain("`--udid SIM-1`");

		const claims = exec.calls.filter((c) => c.args[1] === "claim");
		expect(claims).toHaveLength(1);
		const session = claims[0]?.options?.env?.WARDEN_SESSION_ID;
		expect(session).toBe(`agent-bench-${RUN_ID}`);
		const agents = exec.calls.filter((c) => c.cmd === "claude");
		expect(agents.map((c) => toolOf(c.args))).toEqual(["warden", "argent", "agent-device"]);
		for (const a of agents) expect(a.options?.env?.WARDEN_SESSION_ID).toBe(session);
		const [w, ar, ad] = agents;
		expect(w?.options?.cwd).toBe(join(runDir, "warden", "sandbox", "work"));
		expect(w?.options?.env?.CLAUDE_CONFIG_DIR).toBe(join(runDir, "warden", "sandbox", "config"));
		expect(existsSync(join(runDir, "warden", "sandbox", "config", "skills", "warden", "SKILL.md"))).toBe(true);
		expect(ar?.args.join(" ")).toContain(`--mcp-config ${join(runDir, "argent", "sandbox", "mcp.json")}`);
		expect(ar?.args).not.toContain("--settings");
		expect(w?.args.join(" ")).toContain(`--settings ${join(runDir, "warden", "sandbox", "settings.json")}`);
		expect(ad?.args.join(" ")).toContain(`--settings ${join(runDir, "agent-device", "sandbox", "settings.json")}`);
		expect(existsSync(join(runDir, "argent", "sandbox", "config", "rules", "argent.md"))).toBe(true);
		expect(ad?.options?.env?.AGENT_DEVICE_STATE_DIR).toBe("/home/u/.agent-device-bench/agent-device");
		expect(existsSync(join(runDir, "agent-device", "sandbox", "config", "skills", "agent-device", "SKILL.md"))).toBe(
			true
		);

		const xcrun = exec.calls.filter((c) => c.cmd === "xcrun").map((c) => c.args[1]);
		expect(xcrun.filter((v) => v === "uninstall")).toHaveLength(3);
		expect(xcrun.filter((v) => v === "install")).toHaveLength(3);
		expect(exec.calls.some((c) => c.cmd === "argent" && c.args.join(" ") === "server start --detach")).toBe(true);
		expect(exec.calls.some((c) => c.cmd === "agent-device" && c.args[0] === "prepare")).toBe(true);
		expect(exec.calls.filter((c) => c.args[1] === "ui" && c.args[2] === "wait")).toHaveLength(3);
		expect(exec.calls.filter((c) => c.args[1] === "release").map((c) => c.args[2])).toEqual(["L1"]);
		expect(lines).toContain("released L1");
	});

	test("--reps interleaves the tools rep by rep, each rep from a fresh install, in its own dir", async () => {
		const exec = fakeExec(rules());
		const { deps: d, lines } = deps(exec);
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), tools: ["warden", "argent"], reps: 2 }, d);
		if (!out.success) throw new Error(String(out.error));
		const { report, runDir } = out.data;
		expect(report.reps).toBe(2);
		expect(report.tools.map((t) => `${t.tool}#${t.rep}:${t.outcome}`)).toEqual([
			"warden#1:passed",
			"warden#2:passed",
			"argent#1:passed",
			"argent#2:passed",
		]);
		expect(exec.calls.filter((c) => c.cmd === "claude").map((c) => toolOf(c.args))).toEqual([
			"warden",
			"argent",
			"warden",
			"argent",
		]);
		for (const dir of ["warden/rep-1", "warden/rep-2", "argent/rep-1", "argent/rep-2"])
			expect(existsSync(join(runDir, dir, "transcript.ndjson"))).toBe(true);
		const installs = exec.calls.filter((c) => c.cmd === "xcrun" && c.args[1] === "install");
		expect(installs).toHaveLength(4);
		expect(lines).toContain("argent 0.27.0: rep 2/2: starting");
		expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("✅ 2/2 passed");
		expect(exec.calls.filter((c) => c.args[1] === "claim")).toHaveLength(1);
		expect(exec.calls.filter((c) => c.args[1] === "release")).toHaveLength(1);
	});

	test("--tools runs only the named tools", async () => {
		const exec = fakeExec(rules());
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), tools: ["warden"] }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools.map((t) => t.tool)).toEqual(["warden"]);
		expect(exec.calls.filter((c) => c.cmd === "claude")).toHaveLength(1);
	});

	test("a tool that is not installed is an unavailable row; the others still run", async () => {
		const exec = fakeExec(rules());
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo() },
			deps(exec, { kitDeps: kitDeps(["agent-device"]) }).deps
		);
		if (!out.success) throw new Error(String(out.error));
		const argent = out.data.report.tools.find((t) => t.tool === "argent");
		expect(argent?.outcome).toBe("unavailable");
		expect(argent?.ran === false ? argent.reason : "").toContain("bun add -g @swmansion/argent");
		expect(out.data.report.tools.map((t) => t.tool)).toEqual(["warden", "argent", "agent-device"]);
		expect(exec.calls.filter((c) => c.cmd === "claude")).toHaveLength(2);
	});

	test("no tool that can run fails before claiming anything", async () => {
		const exec = fakeExec(rules());
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo(), tools: ["argent"] },
			deps(exec, { kitDeps: kitDeps([]) }).deps
		);
		expect(out.success).toBe(false);
		expect(exec.calls.some((c) => c.args[1] === "claim")).toBe(false);
	});

	test("a failing prepare is setup_failed for that tool only", async () => {
		const r = rules();
		r.unshift({ cmd: "agent-device", match: (a) => a[0] === "prepare", result: { code: 1, stderr: "no xcode" } });
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(fakeExec(r)).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools.map((t) => t.outcome)).toEqual(["passed", "passed", "setup_failed"]);
	});

	test("a failed success check is a failed run; the lease is still released", async () => {
		const exec = fakeExec(rules({ checkCode: 1 }));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), tools: ["warden"] }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools[0]?.outcome).toBe("failed");
		expect(exec.calls.filter((c) => c.args[1] === "release")).toHaveLength(1);
	});

	test("more assistant turns than maxTurns is a turn_limit run", async () => {
		const many = Array.from({ length: 7 }, (_, i) => bash(`t${i}`, "warden ui snapshot"));
		const exec = fakeExec(rules({ claude: { code: 0, stdout: [...many, done].join("\n") } }));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), tools: ["warden"] }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools[0]?.outcome).toBe("turn_limit");
	});

	test("no result event is an agent_error with the stderr tail", async () => {
		const exec = fakeExec(rules({ claude: { code: 1, stderr: "Invalid API key" } }));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), tools: ["warden"] }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		const warden = ranOf(out.data.report.tools, "warden");
		expect(warden.outcome).toBe("agent_error");
		expect(warden.stderrTail).toBe("Invalid API key");
	});

	test("no credentials fails before claiming anything", async () => {
		const exec = fakeExec(rules());
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(exec, { env: { PATH: "/x" } }).deps);
		expect(out.success).toBe(false);
		expect(exec.calls).toHaveLength(0);
	});

	test("--udid runs as the caller's session and releases nothing", async () => {
		const exec = fakeExec(rules());
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo(), udid: "MINE" },
			deps(exec, { env: { ...AUTH, CLAUDE_CODE_SESSION_ID: "outer" } }).deps
		);
		if (!out.success) throw new Error(String(out.error));
		expect(exec.calls.some((c) => c.args[1] === "claim" || c.args[1] === "release")).toBe(false);
		expect(exec.calls.find((c) => c.cmd === "claude")?.options?.env?.WARDEN_SESSION_ID).toBe("outer");
	});

	test("--udid without a session to run as is refused", async () => {
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo(), udid: "MINE" }, deps(fakeExec(rules())).deps);
		expect(out.success).toBe(false);
	});
});

describe("abort", () => {
	test("Ctrl-C during the first agent stops it; later tools are not_run, and the run still reports and releases", async () => {
		const controller = new AbortController();
		const exec = fakeExec(
			rules({
				claude: () => {
					controller.abort();
					return { code: 143, stdout: "" };
				},
			})
		);
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo() },
			deps(exec, { signal: controller.signal, kill: () => {} }).deps
		);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools.map((t) => t.outcome)).toEqual(["aborted", "not_run", "not_run"]);
		expect(exec.calls.filter((c) => c.cmd === "claude")).toHaveLength(1);
		expect(exec.calls.filter((c) => c.args[1] === "release")).toHaveLength(1);
	});

	test("with reps, every later tool and rep is not_run", async () => {
		const controller = new AbortController();
		const exec = fakeExec(
			rules({
				claude: () => {
					controller.abort();
					return { code: 143, stdout: "" };
				},
			})
		);
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo(), tools: ["warden", "argent"], reps: 2 },
			deps(exec, { signal: controller.signal, kill: () => {} }).deps
		);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.tools.map((t) => `${t.tool}#${t.rep}:${t.outcome}`)).toEqual([
			"warden#1:aborted",
			"warden#2:not_run",
			"argent#1:not_run",
			"argent#2:not_run",
		]);
	});
});
