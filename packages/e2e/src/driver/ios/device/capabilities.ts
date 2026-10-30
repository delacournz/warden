import type { DriverCapabilities } from "../../driver.types";

/** Capabilities exactly as the plan fixes them (WDN-PHY-6). */
export const IOS_DEVICE_CAPABILITIES: DriverCapabilities = {
	pinch: false,
	maxPointers: 0,
	unicodeText: true,
	nativeSettle: false,
	alerts: true,
	reachability: true,
	cheapHitTest: false,
};
