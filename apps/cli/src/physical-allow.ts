import type { DeviceRequest } from "@delacour/warden-core/types";

/** `WARDEN_PHYSICAL_IDS`: comma-separated adb serials / CoreDevice UDIDs; blank or unset is no list. */
export function parsePhysicalIds(raw: string | undefined): string[] | undefined {
	const ids = [...new Set((raw ?? "").split(",").flatMap((id) => (id.trim() === "" ? [] : [id.trim()])))];
	return ids.length > 0 ? ids : undefined;
}

/** The physical-device allowlist: `WARDEN_PHYSICAL_IDS` wins over the repo config's `physical.allow`. */
export function resolvePhysicalAllow(
	env: Record<string, string | undefined>,
	configAllow: string[] | undefined
): string[] | undefined {
	return parsePhysicalIds(env.WARDEN_PHYSICAL_IDS) ?? configAllow;
}

/** An id-less physical claim only picks from `allow`; naming devices (`--udid` / `--serial`) beats the list. */
export function applyPhysicalAllow(request: DeviceRequest, allow: string[] | undefined): DeviceRequest {
	if (!request.physical || request.physical.ids !== undefined || allow === undefined) return request;
	return { ...request, physical: { ...request.physical, allow } };
}
