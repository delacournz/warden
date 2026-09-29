import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { codexHome } from "./codex-hooks";

/** Coding agents `warden install` can wire hooks into. */
export type Agent = "claude" | "codex";

type Env = Record<string, string | undefined>;

/** True when `name` is an executable file in one of `env.PATH`'s directories (never the process PATH). */
export function onPath(env: Env, name: string): boolean {
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

function isDir(path: string | undefined): boolean {
	try {
		return path !== undefined && existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Claude Code: `~/.claude` exists or `claude` on PATH. */
export function claudeDetected(env: Env): boolean {
	return isDir(env.HOME ? join(env.HOME, ".claude") : undefined) || onPath(env, "claude");
}

/** Codex: `$CODEX_HOME` / `~/.codex` exists or `codex` on PATH. */
export function codexDetected(env: Env): boolean {
	return isDir(codexHome(env)) || onPath(env, "codex");
}

/** Agents present on this machine, in install order. */
export function detectAgents(env: Env): Agent[] {
	const agents: Agent[] = [];
	if (claudeDetected(env)) agents.push("claude");
	if (codexDetected(env)) agents.push("codex");
	return agents;
}
