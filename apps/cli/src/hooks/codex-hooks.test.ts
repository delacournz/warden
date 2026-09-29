import { afterEach, describe, expect, test } from "bun:test";
import { hookCommand } from "../commands/hook";
import { type TestContext, testContext } from "../testing";
import { hasWardenHook } from "./claude-settings";
import { CODEX_HOOKS, codexHome, codexHooksPath, codexTomlHasWardenHook, mergeCodexHooks } from "./codex-hooks";

const BIN = "$HOME/.local/bin/warden";

function merged(existing: unknown) {
	const result = mergeCodexHooks(existing, BIN);
	if (!result.success) throw new Error(result.error);
	return result.data;
}

describe("codexHome / codexHooksPath", () => {
	test("$CODEX_HOME wins, else ~/.codex", () => {
		expect(codexHome({ HOME: "/h", CODEX_HOME: "/c" })).toBe("/c");
		expect(codexHome({ HOME: "/h" })).toBe("/h/.codex");
		expect(codexHome({ HOME: "/h", CODEX_HOME: "" })).toBe("/h/.codex");
		expect(codexHome({})).toBeUndefined();
		expect(codexHooksPath({ HOME: "/h" })).toBe("/h/.codex/hooks.json");
	});
});

describe("mergeCodexHooks", () => {
	test("empty → hooks.json with argent PreToolUse + SessionEnd (3 s cap)", () => {
		const { settings, changed } = merged(undefined);
		expect(changed).toBe(true);
		expect(settings).toEqual({
			hooks: {
				PreToolUse: [
					{
						matcher: "mcp__argent__.*|mcp__plugin_goldie_argent__.*",
						hooks: [{ type: "command", command: `${BIN} hook pretool`, timeout: 30 }],
					},
				],
				SessionEnd: [{ hooks: [{ type: "command", command: `${BIN} hook session-end`, timeout: 3 }] }],
			},
		});
		expect(CODEX_HOOKS.every((h) => h.event !== "SessionEnd" || h.timeout <= 3)).toBe(true);
	});

	test("preserves other keys + hooks, idempotent", () => {
		const existing = {
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
				Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
			},
		};
		const before = structuredClone(existing);
		const first = merged(existing);
		expect(existing).toEqual(before);
		const hooks = first.settings.hooks as Record<string, unknown[]>;
		expect(hooks.Stop).toEqual(before.hooks.Stop);
		expect(hooks.PreToolUse).toHaveLength(2);
		expect(hooks.PreToolUse?.[0]).toEqual(before.hooks.PreToolUse[0]);
		const second = merged(first.settings);
		expect(second.changed).toBe(false);
		expect(second.settings).toEqual(first.settings);
	});

	test("errors mention hooks.json", () => {
		const bad = mergeCodexHooks({ hooks: [] }, BIN);
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("hooks.json");
	});
});

describe("codexTomlHasWardenHook", () => {
	const toml = `model = "gpt-5"

[[hooks.PreToolUse]]
matcher = "mcp__argent__.*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "$HOME/.local/bin/warden hook pretool"
`;
	test("finds warden hooks declared in config.toml", () => {
		expect(codexTomlHasWardenHook(toml, "pretool")).toBe(true);
		expect(codexTomlHasWardenHook(toml, "session-end")).toBe(false);
	});

	test("missing / invalid TOML → false", () => {
		expect(codexTomlHasWardenHook(undefined, "pretool")).toBe(false);
		expect(codexTomlHasWardenHook("[[[ nope", "pretool")).toBe(false);
	});

	test("hooks.json shape is understood by hasWardenHook", () => {
		expect(hasWardenHook(merged({}).settings, "session-end")).toBe(true);
	});
});

/** Payloads as Codex sends them (codex-rs/hooks/src/schema.rs): Claude's fields plus turn_id/model/etc. */
describe("warden hook with Codex payloads", () => {
	let ctx: TestContext | undefined;
	afterEach(() => ctx?.cleanup());
	const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

	function run(argv: string[], stdin: unknown): TestContext {
		ctx = testContext(argv, { readStdin: async () => JSON.stringify(stdin) });
		return ctx;
	}

	const codexPreTool = (sessionId: string) => ({
		session_id: sessionId,
		turn_id: "turn-1",
		transcript_path: null,
		cwd: "/nonexistent",
		hook_event_name: "PreToolUse",
		model: "gpt-5-codex",
		permission_mode: "default",
		tool_name: "mcp__argent__describe",
		tool_use_id: "call_1",
		tool_input: { udid: UDID },
	});

	test("pretool leases the device for the Codex session", async () => {
		const c = run(["pretool"], codexPreTool("019a-thread"));
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.db.listLeases()[0]?.owner).toMatchObject({ kind: "agent", sessionId: "019a-thread" });
	});

	test("a second Codex session is blocked with exit 2 + stderr reason (Codex's blocking contract)", async () => {
		const c = run(["pretool"], codexPreTool("thread-a"));
		await hookCommand.run(c);
		c.readStdin = async () => JSON.stringify(codexPreTool("thread-b"));
		expect(await hookCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain(`device ${UDID} leased by agent thread-a`);
	});

	test("session-end (reason always `other` in Codex) releases the session's leases", async () => {
		const c = run(["pretool"], codexPreTool("thread-a"));
		await hookCommand.run(c);
		c.argv = ["session-end"];
		c.readStdin = async () =>
			JSON.stringify({
				session_id: "thread-a",
				transcript_path: null,
				cwd: "/nonexistent",
				hook_event_name: "SessionEnd",
				reason: "other",
			});
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toEqual([]);
	});
});
