import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import type { Project } from "./config";

/** What warden reads off a resolved Expo config: the ids `app.json` would carry, plus the slug and scheme. */
export type ExpoAppInfo = {
	slug?: string;
	scheme?: string;
	bundleId: Project["bundleId"];
};

/** The whole config resolved by Expo itself (plugins, functions, env), as JSON on stdout. */
export const EXPO_CONFIG_ARGV = ["bunx", "expo", "config", "--json", "--type", "public"] as const;
export const EXPO_CONFIG_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const firstString = (...values: unknown[]): string | undefined => values.map(str).find((v) => v !== undefined);

/** `expo config --json` output → the fields warden needs; the bundle id keys are the ones `app.json` uses. */
export function parseExpoConfig(stdout: string): ExpoAppInfo | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) return undefined;
	const ios = isRecord(raw.ios) ? str(raw.ios.bundleIdentifier) : undefined;
	const android = isRecord(raw.android) ? str(raw.android.package) : undefined;
	const scheme = Array.isArray(raw.scheme) ? firstString(...raw.scheme) : str(raw.scheme);
	return {
		...(str(raw.slug) ? { slug: str(raw.slug) } : {}),
		...(scheme ? { scheme } : {}),
		bundleId: { ...(ios ? { ios } : {}), ...(android ? { android } : {}) },
	};
}

/**
 * A dynamic `app.config.{ts,js,mjs,cjs}` can only be read by Expo: run `expo config` in `dir` and
 * take the slug, scheme and bundle ids from the result. Fails with Expo's own stderr when it can't.
 */
export async function readExpoConfig(exec: Exec, dir: string): AsyncResult<ExpoAppInfo> {
	const res = await exec([...EXPO_CONFIG_ARGV], {
		cwd: dir,
		env: { EXPO_NO_TELEMETRY: "1", CI: "1" },
		timeoutMs: EXPO_CONFIG_TIMEOUT_MS,
	});
	const info = res.exitCode === 0 ? parseExpoConfig(res.stdout) : undefined;
	if (info) return ok(info);
	const why = (res.stderr || res.stdout).trim().split("\n").filter(Boolean).slice(-3).join(" ");
	return err(
		`\`${EXPO_CONFIG_ARGV.join(" ")}\` in ${dir} ${res.exitCode === 0 ? "printed no config" : `failed (exit ${res.exitCode})`}${why ? `: ${why}` : ""}`
	);
}
