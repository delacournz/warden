import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { Kit } from "./kit";

/**
 * The agent's world: a fresh `CLAUDE_CONFIG_DIR` holding only the tool's skills and always-on rules (no user
 * CLAUDE.md, settings, hooks, plugins or MCP servers), an empty working directory, the kit's shims first on PATH
 * and, for an MCP tool, an `mcp.json` with only its server. `HOME` is kept: warden's lease store (`~/.warden`)
 * and the simulator tools live under it, and the agent must see the lease the bench claimed.
 */
export type Sandbox = {
	root: string;
	configDir: string;
	workDir: string;
	binDir: string;
	/** `--mcp-config` path; absent when the kit has no MCP server */
	mcpConfigPath?: string;
	/** `--settings` path (the Bash gate hook); absent when the kit has none */
	settingsPath?: string;
	/** the agent's environment: `base` minus anything that would point a tool at another session or device */
	env(base: Record<string, string | undefined>, wardenSessionId: string): Record<string, string | undefined>;
};

export type SandboxKit = Pick<Kit, "files" | "shims" | "mcpServers" | "env" | "bashGate">;

/** Settings with one `PreToolUse` hook on Bash: the kit's gate decides every call. */
export function gateSettings(argv: readonly string[]): Record<string, unknown> {
	return {
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: argv.map(shellQuote).join(" ") }] }],
		},
	};
}

/** Removed from the agent's env: an outer session id would make the bench's lease look foreign. */
const DROPPED_ENV = [
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_SESSION_ID",
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"WARDEN_UDID",
	"WARDEN_UDIDS",
	"WARDEN_SERIAL",
] as const;

function shellQuote(s: string): string {
	return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function createSandbox(root: string, kit: SandboxKit): Sandbox {
	const configDir = join(root, "config");
	const workDir = join(root, "work");
	const binDir = join(root, "bin");
	rmSync(root, { recursive: true, force: true });
	for (const dir of [configDir, workDir, binDir]) mkdirSync(dir, { recursive: true });
	for (const file of kit.files) {
		const target = join(configDir, file.to);
		mkdirSync(dirname(target), { recursive: true });
		const excluded = new Set((file.exclude ?? []).map((e) => join(file.from, e)));
		cpSync(file.from, target, { recursive: true, filter: (src) => !excluded.has(src) });
	}
	for (const shim of kit.shims) {
		const path = join(binDir, shim.name);
		writeFileSync(path, `#!/bin/sh\nexec ${shim.argv.map(shellQuote).join(" ")} "$@"\n`);
		chmodSync(path, 0o755);
	}
	const mcpConfigPath = Object.keys(kit.mcpServers).length > 0 ? join(root, "mcp.json") : undefined;
	if (mcpConfigPath !== undefined)
		writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: kit.mcpServers }, null, 2)}\n`);
	const settingsPath = kit.bashGate !== undefined ? join(root, "settings.json") : undefined;
	if (settingsPath !== undefined && kit.bashGate !== undefined)
		writeFileSync(settingsPath, `${JSON.stringify(gateSettings(kit.bashGate), null, 2)}\n`);
	return {
		root,
		configDir,
		workDir,
		binDir,
		...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
		...(settingsPath !== undefined ? { settingsPath } : {}),
		env(base, wardenSessionId) {
			const env: Record<string, string | undefined> = { ...base };
			for (const key of DROPPED_ENV) delete env[key];
			env.PATH = base.PATH ? `${binDir}:${base.PATH}` : binDir;
			env.CLAUDE_CONFIG_DIR = configDir;
			env.WARDEN_SESSION_ID = wardenSessionId;
			return { ...env, ...kit.env };
		},
	};
}

/**
 * A fresh config dir has no login, so the agent authenticates from the environment: `CLAUDE_CODE_OAUTH_TOKEN`
 * (`claude setup-token`, uses the subscription) or `ANTHROPIC_API_KEY`.
 */
export function authEnv(env: Record<string, string | undefined>): Result<"oauth" | "api-key"> {
	if (env.CLAUDE_CODE_OAUTH_TOKEN) return ok("oauth");
	if (env.ANTHROPIC_API_KEY) return ok("api-key");
	return err(
		"no Claude credentials for the isolated agent: export CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY"
	);
}
