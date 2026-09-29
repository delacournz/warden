import { join } from "node:path";
import type { Result } from "@warden/types/result";
import { ARGENT_MATCHER } from "./claude-pretool";
import {
	type HookName,
	hasWardenHook,
	type MergedSettings,
	mergeWardenHooks,
	type WardenHookSpec,
} from "./claude-settings";

type Env = Record<string, string | undefined>;

/**
 * Hooks `warden install --codex` adds to `$CODEX_HOME/hooks.json`. Codex runs Claude-compatible command
 * hooks (same stdin JSON, exit 2 + stderr blocks a PreToolUse), but caps SessionEnd at 3 s
 * (codex-rs/hooks/src/events/session_end.rs: default 1 s, max 3 s).
 */
export const CODEX_HOOKS: readonly WardenHookSpec[] = [
	{ event: "PreToolUse", name: "pretool", matcher: ARGENT_MATCHER, timeout: 30 },
	{ event: "SessionEnd", name: "session-end", timeout: 3 },
];

/** Codex's config dir: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: Env): string | undefined {
	if (env.CODEX_HOME) return env.CODEX_HOME;
	return env.HOME ? join(env.HOME, ".codex") : undefined;
}

export function codexHooksPath(env: Env): string | undefined {
	const home = codexHome(env);
	return home ? join(home, "hooks.json") : undefined;
}

export function codexConfigPath(env: Env): string | undefined {
	const home = codexHome(env);
	return home ? join(home, "config.toml") : undefined;
}

/** Add warden's hooks to a Codex `hooks.json` document. Pure + idempotent. */
export function mergeCodexHooks(existing: unknown, binary: string): Result<MergedSettings> {
	return mergeWardenHooks(existing, binary, CODEX_HOOKS, "hooks.json");
}

/** True when `config.toml` declares the warden hook `name` in its `[[hooks.<Event>]]` tables. */
export function codexTomlHasWardenHook(toml: string | undefined, name: HookName): boolean {
	if (toml === undefined) return false;
	try {
		return hasWardenHook(Bun.TOML.parse(toml), name);
	} catch {
		return false;
	}
}
