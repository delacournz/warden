import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hookCodexHooks } from "./codex-hooks";

/** Coding agents `warden install` can wire hooks into. */
export type Agent = "claude" | "codex";

type Env = Record<string, string | undefined>;

export class HookAgents {
	/** True when `name` is an executable file in one of `env.PATH`'s directories (never the process PATH). */
	onPath(env: Env, name: string): boolean {
		for (const dir of (env.PATH ?? "").split(delimiter)) {
			if (dir === "") continue;
			const candidate = join(dir, name);
			try {
				if (!statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				// not here
			}
		}
		return false;
	}

	private isDir(path: string | undefined): boolean {
		try {
			return path !== undefined && existsSync(path) && statSync(path).isDirectory();
		} catch {
			return false;
		}
	}

	/** Claude Code: `~/.claude` exists or `claude` on PATH. */
	claudeDetected(env: Env): boolean {
		return this.isDir(env.HOME ? join(env.HOME, ".claude") : undefined) || this.onPath(env, "claude");
	}

	/** Codex: `$CODEX_HOME` / `~/.codex` exists or `codex` on PATH. */
	codexDetected(env: Env): boolean {
		return this.isDir(hookCodexHooks.codexHome(env)) || this.onPath(env, "codex");
	}

	/** Agents present on this machine, in install order. */
	detectAgents(env: Env): Agent[] {
		const agents: Agent[] = [];
		if (this.claudeDetected(env)) agents.push("claude");
		if (this.codexDetected(env)) agents.push("codex");
		return agents;
	}
}

export const hookAgents = new HookAgents();
