import { textSizes } from "@delacour/warden-config/text-size";
import { driverErrors } from "./errors";

export const PUSH_MAX_BYTES = 4096;

/** Checks shared by both platforms' device-setting ops; each returns a message, or undefined when fine. Use the shared {@link deviceSettings} singleton. */
export class DeviceSettings {
	timezoneProblem(tz: string): string | undefined {
		try {
			new Intl.DateTimeFormat("en", { timeZone: tz });
			return undefined;
		} catch {
			return `"${tz}" is not an IANA timezone (use e.g. Pacific/Auckland or UTC)`;
		}
	}

	localeProblem(tag: string): string | undefined {
		try {
			return Intl.getCanonicalLocales(tag).length > 0 ? undefined : `"${tag}" is not a locale tag`;
		} catch {
			return `"${tag}" is not a BCP 47 locale tag (use e.g. fr-FR)`;
		}
	}

	batteryProblem(level: number | undefined): string | undefined {
		if (level === undefined) return undefined;
		return Number.isInteger(level) && level >= 0 && level <= 100
			? undefined
			: `battery level must be a whole number 0-100, got ${String(level)}`;
	}

	pushProblem(payload: unknown): string | undefined {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload))
			return "a push payload must be an object";
		const aps = (payload as Record<string, unknown>).aps;
		if (typeof aps !== "object" || aps === null || Array.isArray(aps)) return "a push payload needs an `aps` object";
		const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
		return bytes > PUSH_MAX_BYTES ? `a push payload is ${bytes} bytes, the limit is ${PUSH_MAX_BYTES}` : undefined;
	}

	/** `E_BAD_REQUEST` for a problem message, else undefined. */
	badRequest(problem: string | undefined) {
		return problem === undefined ? undefined : driverErrors.err("E_BAD_REQUEST", problem);
	}
}

export const deviceSettings = new DeviceSettings();

export { textSizes };
