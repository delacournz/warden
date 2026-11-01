import { type Result, resultFactory } from "@delacour/warden-types/result";
import { hookJson, type Json, type JsonObject } from "./json";

export type HookName = "pretool" | "session-end";

/** Hooks older versions installed that `warden install` now removes (`warden hook pretool` is a no-op). */
export const RETIRED_HOOKS: readonly HookName[] = ["pretool"];

export type WardenHookSpec = {
	event: "SessionEnd";
	name: HookName;
	matcher?: string;
	timeout: number;
};

/** Hooks `warden install --claude` adds to `~/.claude/settings.json`. */
export const WARDEN_HOOKS: readonly WardenHookSpec[] = [{ event: "SessionEnd", name: "session-end", timeout: 30 }];

export type MergedSettings = { settings: JsonObject; changed: boolean };

export class HookClaudeSettings {
	/** Matches `warden hook <name>` in any hook command (bare `warden` or a path to the binary). */
	private commandPattern(name: HookName): RegExp {
		return new RegExp(`(^|[\\s/"'])warden["']?\\s+hook\\s+${name}(\\s|$)`);
	}

	private groupHasHook(group: unknown, name: HookName): boolean {
		if (!hookJson.isRecord(group) || !Array.isArray(group.hooks)) return false;
		const pattern = this.commandPattern(name);
		return group.hooks.some((h) => hookJson.isRecord(h) && typeof h.command === "string" && pattern.test(h.command));
	}

	/** True when settings already contain the warden hook `name`. */
	hasWardenHook(settings: unknown, name: HookName): boolean {
		if (!hookJson.isRecord(settings) || !hookJson.isRecord(settings.hooks)) return false;
		return Object.values(settings.hooks).some(
			(groups) => Array.isArray(groups) && groups.some((g) => this.groupHasHook(g, name))
		);
	}

	/** Drops the `warden hook <name>` commands of retired hooks; a group left without hooks goes too. Returns whether anything went. */
	private removeRetired(hooks: JsonObject): boolean {
		let removed = false;
		for (const [event, groups] of Object.entries(hooks)) {
			if (!Array.isArray(groups)) continue;
			let touched = false;
			const kept = groups.flatMap((group: Json): Json[] => {
				if (!hookJson.isJsonObject(group) || !Array.isArray(group.hooks)) return [group];
				const left = group.hooks.filter(
					(h) =>
						!(
							hookJson.isRecord(h) &&
							typeof h.command === "string" &&
							RETIRED_HOOKS.some((name) => this.commandPattern(name).test(String(h.command)))
						)
				);
				if (left.length === group.hooks.length) return [group];
				touched = true;
				removed = true;
				return left.length > 0 ? [{ ...group, hooks: left }] : [];
			});
			if (!touched) continue;
			if (kept.length > 0) hooks[event] = kept;
			else delete hooks[event];
		}
		return removed;
	}

	/**
	 * Add `specs` to a Claude-style hooks document (`{ hooks: { Event: [{ matcher?, hooks: [...] }] } }` —
	 * Claude's settings.json and Codex's hooks.json share it). Pure + idempotent: other keys and hooks are
	 * preserved, a hook already present (by `warden hook <name>` command) is never duplicated.
	 * `existing` undefined = no file yet; `file` names it in errors.
	 */
	mergeWardenHooks(
		existing: unknown,
		binary: string,
		specs: readonly WardenHookSpec[],
		file: string
	): Result<MergedSettings> {
		const base = existing === undefined ? {} : existing;
		if (!hookJson.isJsonObject(base)) return resultFactory.err(`${file} is not a JSON object`);
		const settings: JsonObject = structuredClone(base);
		const rawHooks = settings.hooks ?? {};
		if (!hookJson.isJsonObject(rawHooks)) return resultFactory.err(`${file} \`hooks\` is not an object`);
		const hooks: JsonObject = rawHooks;
		let changed = this.removeRetired(hooks);
		for (const spec of specs) {
			const groups = hooks[spec.event] ?? [];
			if (!Array.isArray(groups)) return resultFactory.err(`${file} \`hooks.${spec.event}\` is not an array`);
			if (groups.some((g) => this.groupHasHook(g, spec.name))) continue;
			const hook: JsonObject = { type: "command", command: `${binary} hook ${spec.name}`, timeout: spec.timeout };
			groups.push(spec.matcher !== undefined ? { matcher: spec.matcher, hooks: [hook] } : { hooks: [hook] });
			hooks[spec.event] = groups;
			changed = true;
		}
		settings.hooks = hooks;
		return resultFactory.ok({ settings, changed });
	}

	/** Add warden's hooks to `~/.claude/settings.json` (see `mergeWardenHooks`). */
	mergeClaudeSettings(existing: unknown, binary: string): Result<MergedSettings> {
		return this.mergeWardenHooks(existing, binary, WARDEN_HOOKS, "settings.json");
	}
}

export const hookClaudeSettings = new HookClaudeSettings();
