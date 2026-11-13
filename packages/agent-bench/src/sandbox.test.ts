import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authEnv, createSandbox, gateSettings, type SandboxKit } from "./sandbox";

function fakeSkill(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-bench-skill-"));
	mkdirSync(join(dir, "references"), { recursive: true });
	mkdirSync(join(dir, "rules"), { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: warden\n---\n");
	writeFileSync(join(dir, "references", "ui.md"), "# ui\n");
	writeFileSync(join(dir, "rules", "warden.md"), "# rule\n");
	return dir;
}

function wardenKit(skillDir = fakeSkill()): SandboxKit {
	return {
		files: [
			{ from: skillDir, to: "skills/warden", exclude: ["rules"] },
			{ from: join(skillDir, "rules", "warden.md"), to: "rules/warden.md" },
		],
		shims: [{ name: "warden", argv: ["/x/bun", "/repo/apps/cli/src/cli.ts"] }],
		mcpServers: {},
		env: {},
	};
}

const root = (): string => mkdtempSync(join(tmpdir(), "agent-bench-sb-"));

describe("createSandbox", () => {
	test("copies the kit's skills and rules into a fresh config dir, honouring excludes", () => {
		const sb = createSandbox(root(), wardenKit());
		expect(readFileSync(join(sb.configDir, "skills", "warden", "SKILL.md"), "utf8")).toContain("name: warden");
		expect(existsSync(join(sb.configDir, "skills", "warden", "references", "ui.md"))).toBe(true);
		expect(existsSync(join(sb.configDir, "skills", "warden", "rules"))).toBe(false);
		expect(readFileSync(join(sb.configDir, "rules", "warden.md"), "utf8")).toBe("# rule\n");
		expect(existsSync(sb.workDir)).toBe(true);
		expect(sb.mcpConfigPath).toBeUndefined();
	});

	test("writes each shim first on PATH", () => {
		const sb = createSandbox(root(), wardenKit());
		const shim = join(sb.binDir, "warden");
		expect(readFileSync(shim, "utf8")).toBe('#!/bin/sh\nexec "/x/bun" "/repo/apps/cli/src/cli.ts" "$@"\n');
		expect(statSync(shim).mode & 0o111).not.toBe(0);
		const env = sb.env({ PATH: "/usr/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/real" }, "sess-1");
		expect(env.PATH).toBe(`${sb.binDir}:/usr/bin`);
		expect(env.CLAUDE_CONFIG_DIR).toBe(sb.configDir);
		expect(env.WARDEN_SESSION_ID).toBe("sess-1");
		expect(env.HOME).toBe("/h");
	});

	test("an MCP kit gets an mcp.json with only its servers, and its env", () => {
		const sb = createSandbox(root(), {
			files: [],
			shims: [],
			mcpServers: { argent: { command: "/g/argent", args: ["mcp"] } },
			env: { AGENT_DEVICE_STATE_DIR: "/s" },
		});
		if (sb.mcpConfigPath === undefined) throw new Error("no mcp.json");
		expect(JSON.parse(readFileSync(sb.mcpConfigPath, "utf8"))).toEqual({
			mcpServers: { argent: { command: "/g/argent", args: ["mcp"] } },
		});
		expect(sb.env({ PATH: "/p" }, "s").AGENT_DEVICE_STATE_DIR).toBe("/s");
	});

	test("a CLI kit's Bash gate becomes a PreToolUse hook in settings.json", () => {
		const sb = createSandbox(root(), { ...wardenKit(), bashGate: ["/x/bun", "/r/bash-gate.ts", "warden"] });
		if (sb.settingsPath === undefined) throw new Error("no settings.json");
		const settings = JSON.parse(readFileSync(sb.settingsPath, "utf8"));
		expect(settings).toEqual(gateSettings(["/x/bun", "/r/bash-gate.ts", "warden"]));
		expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
		expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('"/x/bun" "/r/bash-gate.ts" "warden"');
		expect(createSandbox(root(), wardenKit()).settingsPath).toBeUndefined();
	});

	test("drops the parent's session ids so the agent owns the bench's lease", () => {
		const sb = createSandbox(root(), wardenKit());
		const env = sb.env(
			{ PATH: "/p", CLAUDE_CODE_SESSION_ID: "outer", CLAUDE_SESSION_ID: "outer", WARDEN_UDID: "X" },
			"s"
		);
		expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(env.CLAUDE_SESSION_ID).toBeUndefined();
		expect(env.WARDEN_UDID).toBeUndefined();
	});
});

describe("authEnv", () => {
	test("an OAuth token or an API key is enough", () => {
		expect(authEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).success).toBe(true);
		expect(authEnv({ ANTHROPIC_API_KEY: "k" }).success).toBe(true);
	});

	test("neither is an error that says how to get one", () => {
		const r = authEnv({});
		expect(r.success).toBe(false);
		if (!r.success) expect(String(r.error)).toContain("claude setup-token");
	});
});
