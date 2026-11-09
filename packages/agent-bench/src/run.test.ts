import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFingerprint } from "@delacour/warden-e2e-bench/src/harness/app";
import { type FakeRule, fakeExec } from "@delacour/warden-e2e-bench/src/harness/exec";
import { reportSchema } from "./report";
import { claudeArgs, runAgentBench, runIdFor } from "./run";
import type { LoadedSuite } from "./suite";
import { suiteSchema } from "./suite.schema";

const AUTH = { CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/usr/bin" };
const NOW = new Date("2026-11-09T10:15:00.000Z");

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

function loaded(overrides: Record<string, unknown> = {}): LoadedSuite {
	const suite = suiteSchema.parse({
		name: "login",
		description: "d",
		prompt: "login.md",
		allowedTools: ["Bash(warden *)", "Skill"],
		maxTurns: 5,
		failurePatterns: ["stale_ref"],
		baseline: { toolCalls: 2, wardenCalls: 2, stumbles: 0, wallMs: 1000 },
		success: [{ wait: "id=settings-screen" }],
		...overrides,
	});
	return { suite, path: "/s/login.yml", promptTemplate: "Drive {{bundleId}} on {{udid}}." };
}

const ev = (v: unknown): string => JSON.stringify(v);
const bash = (id: string, command: string): string =>
	ev({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
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

function rules(transcript: string[], checkCode = 0): FakeRule[] {
	const bun = process.execPath;
	const is = (verb: string) => (a: readonly string[]) => a[1] === verb;
	return [
		{
			cmd: bun,
			match: is("claim"),
			result: { stdout: ev({ leases: [{ leaseId: "L1", udid: "SIM-1", name: "iPhone" }], udids: ["SIM-1"] }) },
		},
		{ cmd: bun, match: is("release"), result: { code: 0 } },
		{ cmd: bun, match: is("heartbeat"), result: { code: 0 } },
		{ cmd: bun, match: (a) => a[1] === "ui" && a[2] === "wait", result: { code: checkCode } },
		{ cmd: bun, match: (a) => a[1] === "ui" && a[2] === "close", result: { code: 0 } },
		{ cmd: "xcrun", result: { code: 0 } },
		{ cmd: "claude", result: { code: 0, stdout: transcript.join("\n"), durationMs: 4200 } },
	];
}

function deps(exec: ReturnType<typeof fakeExec>, env: Record<string, string> = AUTH) {
	const lines: string[] = [];
	return {
		lines,
		deps: { exec, env, now: () => NOW, log: (l: string) => lines.push(l), bunPath: process.execPath, heartbeatMs: 1e9 },
	};
}

describe("runIdFor", () => {
	test("compact UTC stamp", () => {
		expect(runIdFor("login", NOW)).toBe("agent-login-20261109T101500Z");
	});
});

describe("claudeArgs", () => {
	test("stream-json, model, tools, no user setup, budget only when set", () => {
		const s = loaded({ maxBudgetUsd: 2 }).suite;
		const args = claudeArgs("P", s, "m");
		expect(args.slice(0, 2)).toEqual(["-p", "P"]);
		expect(args).toContain("stream-json");
		expect(args).toContain("--verbose");
		expect(args.join(" ")).toContain("--allowedTools Bash(warden *) Skill --permission-mode dontAsk");
		expect(args.join(" ")).toContain("--strict-mcp-config --setting-sources user");
		expect(args.join(" ")).toContain("--max-budget-usd 2");
		expect(claudeArgs("P", loaded().suite, "m")).not.toContain("--max-budget-usd");
	});
});

describe("runAgentBench", () => {
	test("claims, installs, runs the agent in the sandbox, checks, reports and releases its lease", async () => {
		const root = repo();
		const exec = fakeExec(
			rules([
				ev({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
				bash("a", "warden ui snapshot -i --udid SIM-1"),
				res("a", "@e1 [button]"),
				bash("b", "warden ui press @e1 --udid SIM-1"),
				res("b", "stale_ref"),
				done,
			])
		);
		const { deps: d, lines } = deps(exec);
		const out = await runAgentBench({ loaded: loaded(), repoRoot: root }, d);
		if (!out.success) throw new Error(String(out.error));
		const { report, runDir } = out.data;
		expect(runDir).toBe(join(root, ".bench", "agent-login-20261109T101500Z"));
		expect(report.outcome).toBe("passed");
		expect(report.udid).toBe("SIM-1");
		expect(report.wallMs).toBe(4200);
		expect(report.metrics.wardenUiCalls).toBe(2);
		expect(report.metrics.errorCodes).toEqual({ stale_ref: 1 });
		expect(report.diff?.find((r) => r.metric === "stumbles")?.actual).toBe(1);
		expect(reportSchema.parse(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).runId).toBe(report.runId);
		expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("# agent bench: login — passed");
		expect(readFileSync(join(runDir, "transcript.ndjson"), "utf8")).toContain("warden ui press");
		expect(readFileSync(join(runDir, "prompt.md"), "utf8")).toBe("Drive nz.co.delacour.warden.example on SIM-1.");

		const claim = exec.calls.find((c) => c.args[1] === "claim");
		const session = claim?.options?.env?.WARDEN_SESSION_ID;
		expect(session).toBe("agent-bench-agent-login-20261109T101500Z");
		const agent = exec.calls.find((c) => c.cmd === "claude");
		expect(agent?.options?.env?.WARDEN_SESSION_ID).toBe(session);
		expect(agent?.options?.env?.CLAUDE_CONFIG_DIR).toBe(join(runDir, "sandbox", "config"));
		expect(agent?.options?.cwd).toBe(join(runDir, "sandbox", "work"));
		expect(existsSync(join(runDir, "sandbox", "config", "skills", "warden", "SKILL.md"))).toBe(true);
		const install = exec.calls.find((c) => c.cmd === "xcrun" && c.args[1] === "install");
		expect(install?.args).toEqual(["simctl", "install", "SIM-1", join(root, ".bench", "app", "ios", "Example.app")]);
		const release = exec.calls.filter((c) => c.args[1] === "release");
		expect(release.map((c) => c.args[2])).toEqual(["L1"]);
		expect(lines).toContain("released L1");
	});

	test("a failed success check is a failed run; the lease is still released", async () => {
		const exec = fakeExec(rules([done], 1));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.outcome).toBe("failed");
		expect(exec.calls.filter((c) => c.args[1] === "release")).toHaveLength(1);
	});

	test("more assistant turns than maxTurns is a turn_limit run", async () => {
		const many = Array.from({ length: 7 }, (_, i) => bash(`t${i}`, "warden ui snapshot"));
		const exec = fakeExec(rules([...many, done]));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(exec).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.outcome).toBe("turn_limit");
	});

	test("no result event is an agent_error with the stderr tail", async () => {
		const r = rules([]);
		const claude = r.findIndex((x) => x.cmd === "claude");
		r[claude] = { cmd: "claude", result: { code: 1, stderr: "Invalid API key" } };
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(fakeExec(r)).deps);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.outcome).toBe("agent_error");
		expect(out.data.report.stderrTail).toBe("Invalid API key");
	});

	test("no credentials fails before claiming anything", async () => {
		const exec = fakeExec(rules([done]));
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, deps(exec, { PATH: "/x" }).deps);
		expect(out.success).toBe(false);
		expect(exec.calls).toHaveLength(0);
	});

	test("--udid runs as the caller's session and releases nothing", async () => {
		const exec = fakeExec(rules([done]));
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo(), udid: "MINE" },
			deps(exec, { ...AUTH, CLAUDE_CODE_SESSION_ID: "outer" }).deps
		);
		if (!out.success) throw new Error(String(out.error));
		expect(exec.calls.some((c) => c.args[1] === "claim" || c.args[1] === "release")).toBe(false);
		expect(exec.calls.find((c) => c.cmd === "claude")?.options?.env?.WARDEN_SESSION_ID).toBe("outer");
	});

	test("--udid without a session to run as is refused", async () => {
		const out = await runAgentBench(
			{ loaded: loaded(), repoRoot: repo(), udid: "MINE" },
			deps(fakeExec(rules([done]))).deps
		);
		expect(out.success).toBe(false);
	});
});

describe("abort", () => {
	test("an aborted signal stops the agent and the run still reports and releases", async () => {
		const controller = new AbortController();
		controller.abort();
		const exec = fakeExec(rules([done]));
		const killed: number[] = [];
		const d = { ...deps(exec).deps, signal: controller.signal, kill: (pid: number) => killed.push(pid) };
		const out = await runAgentBench({ loaded: loaded(), repoRoot: repo() }, d);
		if (!out.success) throw new Error(String(out.error));
		expect(out.data.report.outcome).toBe("aborted");
		expect(exec.calls.filter((c) => c.args[1] === "release")).toHaveLength(1);
	});
});
