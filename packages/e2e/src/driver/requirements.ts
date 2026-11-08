import type { DriverCapabilities, Platform } from "./driver.types";
import { IOS_DEVICE_CAPABILITIES } from "./ios/device/capabilities";

/**
 * What a spec can ask of its device with `test(title, { requires: [...] })`:
 * - `pinch`: two-finger `pinch` / `rotate` (`capabilities.pinch`)
 * - `multiTouch`: a gesture path with more than one finger (`capabilities.maxPointers` of 2)
 */
export type Requirement = "pinch" | "multiTouch";

/** The device a spec was collected for, as the env says (`WARDEN_PLATFORM`, `WARDEN_DEVICE_KIND`). */
export type RequirementTarget = { platform: Platform | undefined; deviceKind?: "physical" | undefined };

/**
 * The capabilities known before any driver is open: a physical iPhone's are fixed (`IOS_DEVICE_CAPABILITIES`).
 * Everything else is decided by the driver at run time (Android depends on `warden-uiad`), so it is undefined.
 */
function staticCapabilities(target: RequirementTarget): DriverCapabilities | undefined {
	return target.platform === "ios" && target.deviceKind === "physical" ? IOS_DEVICE_CAPABILITIES : undefined;
}

const met = (capabilities: DriverCapabilities, requirement: Requirement): boolean => {
	switch (requirement) {
		case "pinch":
			return capabilities.pinch;
		case "multiTouch":
			return capabilities.maxPointers >= 2;
	}
};

/** The `requires` the target's driver is known to lack: a spec with any of them is skipped when collected. */
export function missingRequirements(
	target: RequirementTarget,
	requires: readonly Requirement[] | undefined
): Requirement[] {
	const capabilities = staticCapabilities(target);
	if (capabilities === undefined || requires === undefined) return [];
	return requires.filter((requirement) => !met(capabilities, requirement));
}
