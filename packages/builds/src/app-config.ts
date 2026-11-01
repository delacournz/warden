import type { Exec } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
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

/** Reads the app's identity (slug, scheme, bundle ids) off a resolved Expo config. */
export class AppConfig {
	/** `expo config --json` output → the fields warden needs; the bundle id keys are the ones `app.json` uses. */
	parse(stdout: string): ExpoAppInfo | undefined {
		let raw: unknown;
		try {
			raw = JSON.parse(stdout);
		} catch {
			return undefined;
		}
		if (!this.isRecord(raw)) return undefined;
		const ios = this.isRecord(raw.ios) ? this.str(raw.ios.bundleIdentifier) : undefined;
		const android = this.isRecord(raw.android) ? this.str(raw.android.package) : undefined;
		const scheme = Array.isArray(raw.scheme) ? this.firstString(...raw.scheme) : this.str(raw.scheme);
		return {
			...(this.str(raw.slug) ? { slug: this.str(raw.slug) } : {}),
			...(scheme ? { scheme } : {}),
			bundleId: { ...(ios ? { ios } : {}), ...(android ? { android } : {}) },
		};
	}

	/**
	 * A dynamic `app.config.{ts,js,mjs,cjs}` can only be read by Expo: run `expo config` in `dir` and
	 * take the slug, scheme and bundle ids from the result. Fails with Expo's own stderr when it can't.
	 */
	async read(exec: Exec, dir: string): AsyncResult<ExpoAppInfo> {
		const res = await exec([...EXPO_CONFIG_ARGV], {
			cwd: dir,
			env: { EXPO_NO_TELEMETRY: "1", CI: "1" },
			timeoutMs: EXPO_CONFIG_TIMEOUT_MS,
		});
		const info = res.exitCode === 0 ? this.parse(res.stdout) : undefined;
		if (info) return resultFactory.ok(info);
		const why = (res.stderr || res.stdout).trim().split("\n").filter(Boolean).slice(-3).join(" ");
		return resultFactory.err(
			`\`${EXPO_CONFIG_ARGV.join(" ")}\` in ${dir} ${res.exitCode === 0 ? "printed no config" : `failed (exit ${res.exitCode})`}${why ? `: ${why}` : ""}`
		);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	private str(value: unknown): string | undefined {
		return typeof value === "string" && value !== "" ? value : undefined;
	}

	private firstString(...values: unknown[]): string | undefined {
		return values.map((v) => this.str(v)).find((v) => v !== undefined);
	}
}

export const appConfig = new AppConfig();
