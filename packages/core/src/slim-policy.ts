import { err, ok, type Result } from "@delacour/warden-types/result";
import { DEFAULT_SLIM_PROFILE, type SlimProfile, validateProfile } from "./sims/slim.profile";

/** A `slim` setting as written in config: on/off, or the categories / labels to leave running. */
export type SlimSetting = boolean | { except?: readonly string[] | undefined; keep?: readonly string[] | undefined };

/** Where a run's `slim` can come from, highest precedence first. */
export type SlimInput = {
	/** `--slim` / `--no-slim` (undefined = not passed) */
	flag?: boolean | undefined;
	/** `e2e.<suite>.slim` / `batches.<name>.slim` */
	config?: SlimSetting | undefined;
	/** the top-level `slim` of `warden.config.ts` */
	topLevel?: SlimSetting | undefined;
	env: Record<string, string | undefined>;
};

/** `WARDEN_SLIM=0` (or `false`, `off`) turns slim off when nothing above it decides. */
export function envSlimOff(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_SLIM?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

function fromSetting(setting: SlimSetting): Result<SlimProfile | false> {
	if (setting === false) return ok(false);
	if (setting === true) return ok(DEFAULT_SLIM_PROFILE);
	const checked = validateProfile({ except: setting.except ?? [], keep: setting.keep ?? [] });
	return checked.success ? checked : err(`slim: ${checked.error}`);
}

/**
 * Precedence: CLI `--slim` / `--no-slim` > suite / preset `slim` > top-level config `slim` >
 * `WARDEN_SLIM` (`0` / `false` = off) > the default profile. `true` is the default profile; an object
 * is validated (a bad category id or label is an error naming it).
 */
export function resolveSlim(input: SlimInput): Result<SlimProfile | false> {
	if (input.flag !== undefined) {
		if (input.flag === false) return ok(false);
		// `--slim` keeps a profile the config chose, else the default
		const layered = input.config ?? input.topLevel;
		return layered === undefined || layered === false ? ok(DEFAULT_SLIM_PROFILE) : fromSetting(layered);
	}
	const setting = input.config ?? input.topLevel;
	if (setting !== undefined) return fromSetting(setting);
	return ok(envSlimOff(input.env) ? false : DEFAULT_SLIM_PROFILE);
}
