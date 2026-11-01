import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	PERMISSION_NAMES,
	type PermissionName,
	type PermissionState,
	permissionNames,
	TEXT_SIZE_NAMES,
	type TextSize,
} from "@delacour/warden-config/conditions.types";
import { type Result, resultFactory } from "@delacour/warden-types/result";

const STATES: readonly PermissionState[] = ["granted", "denied", "unset"];

export class UiSettingsParse {
	private isState(v: string): v is PermissionState {
		return (STATES as readonly string[]).includes(v);
	}

	/** `location=denied camera=granted`: permission name to state, each name once. */
	parsePermissionPairs(args: readonly string[]): Result<Partial<Record<PermissionName, PermissionState>>> {
		if (args.length === 0) return resultFactory.err("permission set needs <name>=<granted|denied|unset> pairs");
		const grants: Partial<Record<PermissionName, PermissionState>> = {};
		for (const arg of args) {
			const [name, state, ...extra] = arg.split("=");
			if (name === undefined || state === undefined || extra.length > 0) {
				return resultFactory.err(`"${arg}" is not <name>=<state> (e.g. location=denied)`);
			}
			if (!permissionNames.has(name))
				return resultFactory.err(`unknown permission "${name}" (use ${PERMISSION_NAMES.join(", ")})`);
			if (!this.isState(state))
				return resultFactory.err(`"${state}" is not a state for ${name} (use ${STATES.join(", ")})`);
			if (grants[name] !== undefined) return resultFactory.err(`permission "${name}" is given twice`);
			grants[name] = state;
		}
		return resultFactory.ok(grants);
	}

	/** A category name or a font scale: `accessibility-large`, `1.5`. */
	parseTextSizeArg(raw: string): Result<TextSize> {
		const scale = Number(raw);
		if (raw.trim() !== "" && Number.isFinite(scale))
			return scale > 0 ? resultFactory.ok(scale) : resultFactory.err(`--text-size scale must be above 0, got ${raw}`);
		return (TEXT_SIZE_NAMES as readonly string[]).includes(raw)
			? resultFactory.ok(raw as TextSize)
			: resultFactory.err(`unknown text size "${raw}" (use ${TEXT_SIZE_NAMES.join(", ")} or a scale like 1.3)`);
	}

	parseLevel(raw: string): Result<number> {
		const level = Number(raw);
		return raw.trim() !== "" && Number.isInteger(level) && level >= 0 && level <= 100
			? resultFactory.ok(level)
			: resultFactory.err(`--level must be a whole number 0-100, got "${raw}"`);
	}

	/** A push payload: inline JSON (starts with `{`) or the path of a JSON file; it must be an object with `aps`. */
	parsePushPayload(arg: string, cwd: string): Result<{ aps: Record<string, unknown> } & Record<string, unknown>> {
		let text = arg;
		if (!arg.trim().startsWith("{")) {
			try {
				text = readFileSync(resolve(cwd, arg), "utf8");
			} catch (error) {
				return resultFactory.err(`cannot read ${arg}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return resultFactory.err("the push payload is not valid JSON");
		}
		if (typeof json !== "object" || json === null || Array.isArray(json))
			return resultFactory.err("the push payload must be a JSON object");
		const aps = (json as Record<string, unknown>).aps;
		if (typeof aps !== "object" || aps === null || Array.isArray(aps))
			return resultFactory.err("the push payload needs an `aps` object");
		return resultFactory.ok({ ...(json as Record<string, unknown>), aps: aps as Record<string, unknown> });
	}
}

export const uiSettingsParse = new UiSettingsParse();
