import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "./kit";
import { classifyCommand, classifyToolUse, createStreamParser, parseTranscript } from "./stream";

const WARDEN: Driver = { kind: "cli", bin: "warden", groups: ["ui"] };
const AGENT_DEVICE: Driver = { kind: "cli", bin: "agent-device", groups: [] };
const ARGENT: Driver = { kind: "mcp", server: "argent" };
const PATTERNS = { driver: WARDEN, failurePatterns: ["stale_ref", "E_TIMEOUT", "target_not_found"] };

function line(value: unknown): string {
	return JSON.stringify(value);
}

function bash(id: string, command: string): string {
	return line({
		type: "assistant",
		message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
	});
}

function result(id: string, content: string, isError = false): string {
	return line({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
	});
}

describe("classifyCommand", () => {
	test("finds warden ui verbs anywhere in a pipeline", () => {
		expect(classifyCommand("warden ui snapshot -i --udid U", WARDEN)).toEqual({ driver: true, verb: "ui snapshot" });
		expect(classifyCommand("cd /x && warden ui press @e3 --udid U | head", WARDEN)).toEqual({
			driver: true,
			verb: "ui press",
		});
		expect(classifyCommand("A=1 warden ls --json", WARDEN)).toEqual({ driver: true, verb: "ls" });
		expect(classifyCommand("echo warden-ish; ls", WARDEN)).toEqual({ driver: false });
	});

	test("agent-device: the first subcommand is the verb", () => {
		expect(classifyCommand("agent-device press @e2 --settle --udid U", AGENT_DEVICE)).toEqual({
			driver: true,
			verb: "press",
		});
		expect(classifyCommand("agent-device snapshot -i", AGENT_DEVICE)).toEqual({ driver: true, verb: "snapshot" });
		expect(classifyCommand("warden ui press @e1", AGENT_DEVICE)).toEqual({ driver: false });
	});

	test("an MCP driver never matches Bash", () => {
		expect(classifyCommand("argent mcp", ARGENT)).toEqual({ driver: false });
	});
});

describe("classifyToolUse", () => {
	test("an MCP driver matches its server's tools; the verb is the tool name", () => {
		expect(classifyToolUse(ARGENT, "mcp__argent__gesture-tap", {})).toEqual({ driver: true, verb: "gesture-tap" });
		expect(classifyToolUse(ARGENT, "mcp__other__describe", {})).toEqual({ driver: false });
		expect(classifyToolUse(ARGENT, "Bash", { command: "argent --version" })).toEqual({ driver: false });
	});

	test("a CLI driver matches Bash commands", () => {
		expect(classifyToolUse(WARDEN, "Bash", { command: "warden ui open x" })).toEqual({ driver: true, verb: "ui open" });
		expect(classifyToolUse(WARDEN, "Read", { file_path: "/x" })).toEqual({ driver: false });
	});
});

describe("createStreamParser", () => {
	test("counts tool calls, driver calls, skill loads, stumbles and error codes", () => {
		const transcript = [
			line({ type: "system", subtype: "init", model: "claude-sonnet-5-5", session_id: "s1" }),
			line({
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "k", name: "Skill", input: { skill: "warden" } }] },
			}),
			result("k", "loaded"),
			bash("a", "warden ui open nz.example --udid U"),
			result("a", "opened"),
			bash("b", "warden ui press @e9 --udid U"),
			result("b", "error stale_ref: @e9 is from generation 2", true),
			bash("c", "warden ui wait id=x --udid U"),
			result("c", '{"ok":false,"error":{"code":"E_TIMEOUT"}}'),
			line({
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "d", name: "Read", input: { file_path: "/x" } }] },
			}),
			result("d", "contents"),
			line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
			line({
				type: "result",
				subtype: "success",
				is_error: false,
				num_turns: 7,
				total_cost_usd: 0.42,
				duration_ms: 51000,
				usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
			}),
		];
		const metrics = parseTranscript(transcript.join("\n"), PATTERNS);
		expect(metrics.toolCalls).toBe(5);
		expect(metrics.toolsByName).toEqual({ Skill: 1, Bash: 3, Read: 1 });
		expect(metrics.driverCalls).toBe(3);
		expect(metrics.driverVerbs).toEqual({ "ui open": 1, "ui press": 1, "ui wait": 1 });
		expect(metrics.skillLoads).toEqual(["warden"]);
		expect(metrics.stumbles).toBe(2);
		expect(metrics.errorCodes).toEqual({ stale_ref: 1, E_TIMEOUT: 1 });
		expect(metrics.assistantTurns).toBe(7);
		expect(metrics.result).toEqual({
			subtype: "success",
			isError: false,
			numTurns: 7,
			costUsd: 0.42,
			durationMs: 51000,
			tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
		});
		expect(metrics.model).toBe("claude-sonnet-5-5");
		expect(metrics.unparsedLines).toBe(0);
	});

	test("reads tool_result content given as text blocks", () => {
		const metrics = parseTranscript(
			[
				bash("a", "warden ui press @e1"),
				line({
					type: "user",
					message: {
						content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "target_not_found" }] }],
					},
				}),
			].join("\n"),
			PATTERNS
		);
		expect(metrics.errorCodes).toEqual({ target_not_found: 1 });
		expect(metrics.stumbles).toBe(1);
	});

	test("matches a code as a whole word only", () => {
		const metrics = parseTranscript(
			[bash("a", "warden ui get"), result("a", "not_stale_refs here")].join("\n"),
			PATTERNS
		);
		expect(metrics.errorCodes).toEqual({});
		expect(metrics.stumbles).toBe(0);
	});

	test("counts a non-zero exit of a non-driver Bash call as a stumble without a code", () => {
		const metrics = parseTranscript([bash("a", "ls /nope"), result("a", "No such file", true)].join("\n"), PATTERNS);
		expect(metrics.stumbles).toBe(1);
		expect(metrics.driverCalls).toBe(0);
	});

	test("keeps going over blank and broken lines and counts the broken ones", () => {
		const metrics = parseTranscript(`\n{not json\n${bash("a", "warden ui snapshot")}\n`, PATTERNS);
		expect(metrics.unparsedLines).toBe(1);
		expect(metrics.driverCalls).toBe(1);
	});

	test("incremental feed reports assistant turns as they arrive", () => {
		const parser = createStreamParser(PATTERNS);
		const turns: number[] = [];
		parser.onTurn((n) => turns.push(n));
		parser.push(line({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }));
		parser.push(bash("a", "warden ui snapshot"));
		expect(turns).toEqual([1, 2]);
		expect(parser.metrics().assistantTurns).toBe(2);
		expect(parser.metrics().result).toBeUndefined();
	});

	test("argent: MCP tool uses are driver calls", () => {
		const use = (id: string, name: string): string =>
			line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { udid: "U" } }] } });
		const metrics = parseTranscript(
			[use("a", "mcp__argent__describe"), use("b", "mcp__argent__gesture-tap"), use("c", "ToolSearch")].join("\n"),
			{ driver: ARGENT, failurePatterns: [] }
		);
		expect(metrics.driverCalls).toBe(2);
		expect(metrics.driverVerbs).toEqual({ describe: 1, "gesture-tap": 1 });
		expect(metrics.toolCalls).toBe(3);
	});

	test("parses the committed sample transcript", () => {
		const text = readFileSync(join(import.meta.dir, "fixtures", "transcript.ndjson"), "utf8");
		const metrics = parseTranscript(text, PATTERNS);
		expect(metrics.unparsedLines).toBe(0);
		expect(metrics.toolCalls).toBeGreaterThan(0);
		expect(metrics.result?.subtype).toBe("success");
	});
});
