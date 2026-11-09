import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authEnv, createSandbox } from "./sandbox";

function fakeSkill(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-bench-skill-"));
	mkdirSync(join(dir, "references"), { recursive: true });
	mkdirSync(join(dir, "rules"), { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: warden\n---\n");
	writeFileSync(join(dir, "references", "ui.md"), "# ui\n");
	writeFileSync(join(dir, "rules", "warden.md"), "# rule\n");
	return dir;
}

describe("createSandbox", () => {
	test("installs the skill and the always-on rule into a fresh config dir", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-bench-sb-"));
		const sb = createSandbox({ root, skillDir: fakeSkill(), cliPath: "/repo/apps/cli/src/cli.ts", bunPath: "/x/bun" });
		expect(readFileSync(join(sb.configDir, "skills", "warden", "SKILL.md"), "utf8")).toContain("name: warden");
		expect(existsSync(join(sb.configDir, "skills", "warden", "references", "ui.md"))).toBe(true);
		expect(existsSync(join(sb.configDir, "skills", "warden", "rules"))).toBe(false);
		expect(readFileSync(join(sb.configDir, "rules", "warden.md"), "utf8")).toBe("# rule\n");
		expect(existsSync(sb.workDir)).toBe(true);
	});

	test("puts a warden shim for this checkout's CLI first on PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-bench-sb-"));
		const sb = createSandbox({ root, skillDir: fakeSkill(), cliPath: "/repo/apps/cli/src/cli.ts", bunPath: "/x/bun" });
		const shim = join(sb.binDir, "warden");
		expect(readFileSync(shim, "utf8")).toBe('#!/bin/sh\nexec "/x/bun" "/repo/apps/cli/src/cli.ts" "$@"\n');
		expect(statSync(shim).mode & 0o111).not.toBe(0);
		const env = sb.env({ PATH: "/usr/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/real" }, "sess-1");
		expect(env.PATH).toBe(`${sb.binDir}:/usr/bin`);
		expect(env.CLAUDE_CONFIG_DIR).toBe(sb.configDir);
		expect(env.WARDEN_SESSION_ID).toBe("sess-1");
		expect(env.HOME).toBe("/h");
	});

	test("drops the parent's session ids so the agent owns the bench's lease", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-bench-sb-"));
		const sb = createSandbox({ root, skillDir: fakeSkill(), cliPath: "/c", bunPath: "/b" });
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
