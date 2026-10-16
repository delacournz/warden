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
				SessionEnd: [{ hooks: [{ type: "command", command: `${BIN} hook session-end`, timeout: 30 }] }],
			},
		});
		expect(WARDEN_HOOKS.map((h) => h.event)).toEqual(["SessionEnd"]);
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
		expect(hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
		expect(hooks.SessionEnd).toHaveLength(1);
	});

	test("idempotent: second merge changes nothing", () => {
		const first = ok({}).settings;
		const second = ok(first);
		expect(second.changed).toBe(false);
		expect(second.settings).toEqual(first);
	});

	test("an existing warden hook with a bare `warden` command counts as installed", () => {
		const existing = {
			hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "warden hook session-end" }] }] },
		};
		const { settings, changed } = ok(existing);
		expect(changed).toBe(false);
		expect((settings.hooks as Record<string, unknown[]>).SessionEnd).toHaveLength(1);
	});

	test("the retired PreToolUse hook of older versions is removed, other PreToolUse hooks stay", () => {
		const existing = {
			hooks: {
				PreToolUse: [
					{ matcher: "mcp__old__.*", hooks: [{ type: "command", command: `${BIN} hook pretool`, timeout: 30 }] },
					{ matcher: "Bash", hooks: [{ type: "command", command: "rtk-rewrite" }] },
					{
						matcher: "mixed",
						hooks: [
							{ type: "command", command: "warden hook pretool" },
							{ type: "command", command: "keep-me" },
						],
					},
				],
				SessionEnd: [{ hooks: [{ type: "command", command: `${BIN} hook session-end`, timeout: 30 }] }],
			},
		};
		const { settings, changed } = ok(existing);
		expect(changed).toBe(true);
		expect((settings.hooks as Record<string, unknown>).PreToolUse).toEqual([
			{ matcher: "Bash", hooks: [{ type: "command", command: "rtk-rewrite" }] },
			{ matcher: "mixed", hooks: [{ type: "command", command: "keep-me" }] },
		]);
		expect((settings.hooks as Record<string, unknown[]>).SessionEnd).toHaveLength(1);
	});

	test("a PreToolUse event left empty is dropped", () => {
		const existing = {
			hooks: { PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: "warden hook pretool" }] }] },
		};
		const { settings } = ok(existing);
		expect(Object.keys(settings.hooks as object)).toEqual(["SessionEnd"]);
	});

	test("rejects non-object settings / hooks", () => {
		expect(mergeClaudeSettings([], BIN).success).toBe(false);
		expect(mergeClaudeSettings("x", BIN).success).toBe(false);
		expect(mergeClaudeSettings({ hooks: [] }, BIN).success).toBe(false);
		expect(mergeClaudeSettings({ hooks: { SessionEnd: {} } }, BIN).success).toBe(false);
	});
});

describe("hasWardenHook", () => {
	test("detects the session-end hook", () => {
		expect(hasWardenHook(ok({}).settings, "session-end")).toBe(true);
		expect(hasWardenHook({}, "session-end")).toBe(false);
		expect(hasWardenHook({ hooks: { SessionEnd: [{ hooks: [{ command: "other" }] }] } }, "session-end")).toBe(false);
	});
});
