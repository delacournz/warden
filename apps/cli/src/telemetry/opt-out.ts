import type { BuildInfo } from "../update/build-info";

/**
 * A cheap "is telemetry certainly off?" that needs none of the client, so the commands that run on every
 * agent call (`claim`, `release`, `ui …`) do not load `@delacournz/cli-telemetry` and its zod just to learn it
 * would send nothing. Only the answers that cannot change are here: an environment opt-out, a development
 * or local build, and `NODE_ENV=test`. `false` means "ask the client", never "on": the stored choice and
 * `warden telemetry disable` are the client's to read. `opt-out.test.ts` pins this to the client's precedence.
 */

function truthy(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "1" || v === "true";
}

export function certainlyOff(env: Record<string, string | undefined>, channel: BuildInfo["channel"]): boolean {
	if (truthy(env.DO_NOT_TRACK) || truthy(env.DELACOUR_TELEMETRY_DISABLED) || truthy(env.WARDEN_TELEMETRY_DISABLED))
		return true;
	if (truthy(env.DELACOUR_TELEMETRY_DEBUG)) return false;
	return env.NODE_ENV === "test" || channel !== "release";
}
