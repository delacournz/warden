import { join } from "node:path";
import type { Result } from "@delacour/warden-types/result";
import { type HookName, hookClaudeSettings, type MergedSettings, type WardenHookSpec } from "./claude-settings";

type Env = Record<string, string | undefined>;

/**
 * Hooks `warden install --codex` adds to `$CODEX_HOME/hooks.json`. Codex runs Claude-compatible command
 * hooks (same stdin JSON, exit 2 + stderr blocks a PreToolUse), but caps SessionEnd at 3 s
 * (codex-rs/hooks/src/events/session_end.rs: default 1 s, max 3 s).
 */
export const CODEX_HOOKS: readonly WardenHookSpec[] = [{ event: "SessionEnd", name: "session-end", timeout: 3 }];

export class HookCodexHooks {
	/** Codex's config dir: `$CODEX_HOME`, else `~/.codex`. */
	codexHome(env: Env): string | undefined {
		if (env.CODEX_HOME) return env.CODEX_HOME;
		return env.HOME ? join(env.HOME, ".codex") : undefined;
	}

	codexHooksPath(env: Env): string | undefined {
		const home = this.codexHome(env);
		return home ? join(home, "hooks.json") : undefined;
	}

	codexConfigPath(env: Env): string | undefined {
		const home = this.codexHome(env);
		return home ? join(home, "config.toml") : undefined;
	}

	/** Add warden's hooks to a Codex `hooks.json` document. Pure + idempotent. */
	mergeCodexHooks(existing: unknown, binary: string): Result<MergedSettings> {
		return hookClaudeSettings.mergeWardenHooks(existing, binary, CODEX_HOOKS, "hooks.json");
	}

	/** True when `config.toml` declares the warden hook `name` in its `[[hooks.<Event>]]` tables. */
	codexTomlHasWardenHook(toml: string | undefined, name: HookName): boolean {
		if (toml === undefined) return false;
		try {
			return hookClaudeSettings.hasWardenHook(Bun.TOML.parse(toml), name);
		} catch {
			return false;
		}
	}
}

export const hookCodexHooks = new HookCodexHooks();
