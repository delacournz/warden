import { describe, expect, test } from "bun:test";
import { hasWardenHook, mergeClaudeSettings, WARDEN_HOOKS } from "./claude-settings";

const BIN = "$HOME/.local/bin/warden";

function ok(existing: unknown) {
	const result = mergeClaudeSettings(existing, BIN);
	if (!result.success) throw new Error(result.error);
	return result.data;
}

describe("mergeClaudeSettings", () => {
	test("empty / missing settings → adds all warden hooks", () => {
		const { settings, changed } = ok(undefined);
		expect(changed).toBe(true);
		expect(settings).toEqual({
			hooks: {
				PreToolUse: [
					{
						matcher: "mcp__argent__.*|mcp__plugin_goldie_argent__.*",
						hooks: [{ type: "command", command: `${BIN} hook pretool`, timeout: 30 }],
					},
				],
				SessionStart: [{ hooks: [{ type: "command", command: `${BIN} hook session-start`, timeout: 10 }] }],
				SessionEnd: [{ hooks: [{ type: "command", command: `${BIN} hook session-end`, timeout: 30 }] }],
			},
		});
		expect(WARDEN_HOOKS.map((h) => h.event)).toEqual(["PreToolUse", "SessionStart", "SessionEnd"]);
	});

	test("preserves other settings and existing hooks, appends without clobbering", () => {
		const existing = {
			model: "opus",
			permissions: { allow: ["Bash(ls)"] },
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk-rewrite" }] }],
				Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
			},
		};
		const before = structuredClone(existing);
		const { settings } = ok(existing);
		expect(existing).toEqual(before);
		expect(settings.model).toBe("opus");
		expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
		const hooks = settings.hooks as Record<string, unknown[]>;
		expect(hooks.Stop).toEqual(before.hooks.Stop);
		expect(hooks.PreToolUse).toHaveLength(2);
		expect(hooks.PreToolUse?.[0]).toEqual(before.hooks.PreToolUse[0]);
	});

	test("idempotent: second merge changes nothing", () => {
		const first = ok({}).settings;
		const second = ok(first);
		expect(second.changed).toBe(false);
		expect(second.settings).toEqual(first);
	});

	test("an existing warden hook with a bare `warden` command counts as installed", () => {
		const existing = {
			hooks: {
				PreToolUse: [{ matcher: "mcp__argent__.*", hooks: [{ type: "command", command: "warden hook pretool" }] }],
			},
		};
		const hooks = ok(existing).settings.hooks as Record<string, unknown[]>;
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.SessionEnd).toHaveLength(1);
	});

	test("rejects non-object settings / hooks", () => {
		expect(mergeClaudeSettings([], BIN).success).toBe(false);
		expect(mergeClaudeSettings("x", BIN).success).toBe(false);
		expect(mergeClaudeSettings({ hooks: [] }, BIN).success).toBe(false);
		expect(mergeClaudeSettings({ hooks: { PreToolUse: {} } }, BIN).success).toBe(false);
	});
});

describe("hasWardenHook", () => {
	test("detects the pretool hook", () => {
		expect(hasWardenHook(ok({}).settings, "pretool")).toBe(true);
		expect(hasWardenHook({}, "pretool")).toBe(false);
		expect(hasWardenHook({ hooks: { PreToolUse: [{ hooks: [{ command: "other" }] }] } }, "pretool")).toBe(false);
	});
});
