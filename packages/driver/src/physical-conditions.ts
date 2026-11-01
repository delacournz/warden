import type { Driver } from "./driver.types";
import { driverErr } from "./errors";

/** The condition and setting ops of a `Driver`: each changes the device (or an app's grants) beyond driving its UI. */
export const PHYSICAL_CONDITION_OPS = [
	"network",
	"networkFaults",
	"location",
	"clock",
	"permissions",
	"timezone",
	"locale",
	"a11y",
	"battery",
	"memoryWarning",
	"push",
] as const satisfies readonly (keyof Driver)[];

type PhysicalConditionOps = Pick<Driver, (typeof PHYSICAL_CONDITION_OPS)[number]>;

/**
 * The condition ops for a physical phone: all `E_UNSUPPORTED`. On a phone they would flip airplane mode (cutting
 * wireless adb), set the system clock, timezone or font scale, or proxy the network of somebody's device; the
 * mechanisms behind them (`simctl`, the emulator console, the injected dylib) are simulator / emulator only.
 */
export function physicalConditionOps(device: string): PhysicalConditionOps {
	const refuse = async (op: string) =>
		driverErr(
			"E_UNSUPPORTED",
			`${op} is not available on ${device}: device conditions and settings run on a simulator or emulator only, warden never changes a phone's network, clock or settings`,
			{ retryable: false }
		);
	return {
		network: () => refuse("network"),
		networkFaults: () => refuse("networkFaults"),
		location: () => refuse("location"),
		clock: () => refuse("clock"),
		permissions: () => refuse("permissions"),
		timezone: () => refuse("timezone"),
		locale: () => refuse("locale"),
		a11y: () => refuse("a11y"),
		battery: () => refuse("battery"),
		memoryWarning: () => refuse("memoryWarning"),
		push: () => refuse("push"),
	};
}
