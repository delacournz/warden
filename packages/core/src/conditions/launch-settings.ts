import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What the next launch of an app on an iOS simulator should carry: a simulator has no per-device timezone or
 * locale, so both ride on the app's launch (`TZ` env, `-AppleLanguages` / `-AppleLocale` args). `warden ui` sets
 * them in one process and launches in another, so they are staged in a file per device; release removes it.
 */
export type LaunchSettings = { timezone?: string; locale?: string };

export function launchSettingsPath(wardenHome: string, udid: string): string {
	return join(wardenHome, "launch-settings", `${udid}.json`);
}

/** The staged settings; none (or an unreadable file) is `{}`. */
export function readLaunchSettings(path: string): LaunchSettings {
	if (!existsSync(path)) return {};
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data !== "object" || data === null) return {};
		const d = data as Record<string, unknown>;
		return {
			...(typeof d.timezone === "string" ? { timezone: d.timezone } : {}),
			...(typeof d.locale === "string" ? { locale: d.locale } : {}),
		};
	} catch {
		return {};
	}
}

/** Replace the staged settings; an empty one removes the file. Returns an error message, or undefined. */
export function writeLaunchSettings(path: string, settings: LaunchSettings): string | undefined {
	try {
		if (settings.timezone === undefined && settings.locale === undefined) {
			rmSync(path, { force: true });
			return undefined;
		}
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(settings));
		renameSync(tmp, path);
		return undefined;
	} catch (error) {
		return `write ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
