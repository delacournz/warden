import { err, ok, type Result } from "@warden/types/result";
import { ARGENT_MATCHER } from "./claude-pretool";
import { isJsonObject, isRecord, type JsonObject } from "./json";

export type HookName = "pretool" | "session-start" | "session-end";

export type WardenHookSpec = {
	event: "PreToolUse" | "SessionStart" | "SessionEnd";
	name: HookName;
	matcher?: string;
	timeout: number;
};

/** Hooks `warden install --claude` adds to `~/.claude/settings.json`. */
export const WARDEN_HOOKS: readonly WardenHookSpec[] = [
	{ event: "PreToolUse", name: "pretool", matcher: ARGENT_MATCHER, timeout: 30 },
	{ event: "SessionStart", name: "session-start", timeout: 10 },
	{ event: "SessionEnd", name: "session-end", timeout: 30 },
];

/** Matches `warden hook <name>` in any hook command (bare `warden` or a path to the binary). */
function commandPattern(name: HookName): RegExp {
	return new RegExp(`(^|[\\s/"'])warden["']?\\s+hook\\s+${name}(\\s|$)`);
}

function groupHasHook(group: unknown, name: HookName): boolean {
	if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
	const pattern = commandPattern(name);
	return group.hooks.some((h) => isRecord(h) && typeof h.command === "string" && pattern.test(h.command));
}

/** True when settings already contain the warden hook `name`. */
export function hasWardenHook(settings: unknown, name: HookName): boolean {
	if (!isRecord(settings) || !isRecord(settings.hooks)) return false;
	return Object.values(settings.hooks).some(
		(groups) => Array.isArray(groups) && groups.some((g) => groupHasHook(g, name))
	);
}

export type MergedSettings = { settings: JsonObject; changed: boolean };

/**
 * Add warden's hooks to Claude settings. Pure + idempotent: other keys and hooks are preserved,
 * a hook already present (by `warden hook <name>` command) is never duplicated.
 * `existing` undefined = no settings file yet.
 */
export function mergeClaudeSettings(existing: unknown, binary: string): Result<MergedSettings> {
	const base = existing === undefined ? {} : existing;
	if (!isJsonObject(base)) return err("settings.json is not a JSON object");
	const settings: JsonObject = structuredClone(base);
	const rawHooks = settings.hooks ?? {};
	if (!isJsonObject(rawHooks)) return err("settings.json `hooks` is not an object");
	const hooks: JsonObject = rawHooks;
	let changed = false;
	for (const spec of WARDEN_HOOKS) {
		const groups = hooks[spec.event] ?? [];
		if (!Array.isArray(groups)) return err(`settings.json \`hooks.${spec.event}\` is not an array`);
		if (groups.some((g) => groupHasHook(g, spec.name))) continue;
		const hook: JsonObject = { type: "command", command: `${binary} hook ${spec.name}`, timeout: spec.timeout };
		groups.push(spec.matcher !== undefined ? { matcher: spec.matcher, hooks: [hook] } : { hooks: [hook] });
		hooks[spec.event] = groups;
		changed = true;
	}
	settings.hooks = hooks;
	return ok({ settings, changed });
}
