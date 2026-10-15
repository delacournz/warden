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
	test("empty → hooks.json with SessionEnd (3 s cap)", () => {
		const { settings, changed } = merged(undefined);
		expect(changed).toBe(true);
		expect(settings).toEqual({
			hooks: {
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
		expect(hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
		expect(hooks.SessionEnd).toHaveLength(1);
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

[[hooks.SessionEnd]]

[[hooks.SessionEnd.hooks]]
type = "command"
command = "$HOME/.local/bin/warden hook session-end"
`;
	test("finds warden hooks declared in config.toml", () => {
		expect(codexTomlHasWardenHook(toml, "session-end")).toBe(true);
		expect(codexTomlHasWardenHook(toml, "pretool")).toBe(false);
	});

	test("missing / invalid TOML → false", () => {
		expect(codexTomlHasWardenHook(undefined, "session-end")).toBe(false);
		expect(codexTomlHasWardenHook("[[[ nope", "session-end")).toBe(false);
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

	test("session-end (reason always `other` in Codex) releases the session's leases", async () => {
		const c = run(["session-end"], {});
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
				owner: { kind: "agent", sessionId: "thread-a", cwd: "/nonexistent" },
				ttlMs: 60_000,
			},
			c.now()
		);
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
