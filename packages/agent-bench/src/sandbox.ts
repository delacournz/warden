import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";

/**
 * The agent's world: a fresh `CLAUDE_CONFIG_DIR` holding only the warden skill and its always-on rule (no user
 * CLAUDE.md, settings, hooks, plugins or MCP servers), an empty working directory, and a `warden` shim for this
 * checkout's CLI first on PATH. `HOME` is kept: warden's lease store (`~/.warden`) and the simulator tools live
 * under it, and the agent must see the lease the bench claimed.
 */
export type Sandbox = {
	root: string;
	configDir: string;
	workDir: string;
	binDir: string;
	/** the agent's environment: `base` minus anything that would point warden at another session or device */
	env(base: Record<string, string | undefined>, wardenSessionId: string): Record<string, string | undefined>;
};

export type SandboxInput = {
	root: string;
	/** `<repo>/skills/warden` */
	skillDir: string;
	/** `<repo>/apps/cli/src/cli.ts` */
	cliPath: string;
	bunPath: string;
};

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

export function createSandbox(input: SandboxInput): Sandbox {
	const configDir = join(input.root, "config");
	const workDir = join(input.root, "work");
	const binDir = join(input.root, "bin");
	rmSync(input.root, { recursive: true, force: true });
	const skillTarget = join(configDir, "skills", "warden");
	mkdirSync(skillTarget, { recursive: true });
	cpSync(input.skillDir, skillTarget, { recursive: true, filter: (src) => src !== join(input.skillDir, "rules") });
	mkdirSync(join(configDir, "rules"), { recursive: true });
	cpSync(join(input.skillDir, "rules", "warden.md"), join(configDir, "rules", "warden.md"));
	mkdirSync(workDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	const shim = join(binDir, "warden");
	writeFileSync(shim, `#!/bin/sh\nexec "${input.bunPath}" "${input.cliPath}" "$@"\n`);
	chmodSync(shim, 0o755);
	return {
		root: input.root,
		configDir,
		workDir,
		binDir,
		env(base, wardenSessionId) {
			const env: Record<string, string | undefined> = { ...base };
			for (const key of DROPPED_ENV) delete env[key];
			env.PATH = base.PATH ? `${binDir}:${base.PATH}` : binDir;
			env.CLAUDE_CONFIG_DIR = configDir;
			env.WARDEN_SESSION_ID = wardenSessionId;
			return env;
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
