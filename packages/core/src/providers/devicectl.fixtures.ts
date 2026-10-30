/**
 * Scrubbed `xcrun devicectl list devices --json-output -` documents (jsonVersion 5, the deprecated
 * `hardwareProperties` / `deviceProperties` / `connectionProperties` keys plus `properties`). Every id,
 * name and address is made up; real captures also carry capability lists, serials and ECIDs, left out here.
 */

export const FAKE_IPHONE_UDID = "00008140-000A0B0C0D0E0F10";
export const FAKE_IPAD_UDID = "00008132-000A0B0C0D0E0F11";
export const FAKE_UNPAIRED_UDID = "00008120-000A0B0C0D0E0F12";

type FakeDevice = {
	udid: string;
	name: string;
	deviceType: string;
	platform?: string;
	reality?: string;
	osVersion: string;
	pairingState?: string;
	transportType?: string;
	tunnelState?: string;
	tunnelIPAddress?: string;
	developerMode?: "enabled" | "disabled";
	ddi?: boolean;
};

/** One `result.devices[]` entry shaped like devicectl's. */
export function devicectlEntry(d: FakeDevice): Record<string, unknown> {
	const developerMode = d.developerMode ?? "enabled";
	return {
		identifier: `AAAAAAAA-BBBB-CCCC-DDDD-${d.udid.slice(-12).padStart(12, "0")}`,
		visibilityClass: "default",
		connectionProperties: {
			pairingState: d.pairingState ?? "paired",
			transportType: d.transportType ?? "wired",
			tunnelState: d.tunnelState ?? "disconnected",
			...(d.tunnelIPAddress === undefined ? {} : { tunnelIPAddress: d.tunnelIPAddress }),
		},
		deviceProperties: {
			bootState: "booted",
			ddiServicesAvailable: d.ddi ?? true,
			developerModeStatus: developerMode,
			name: d.name,
			osVersionNumber: d.osVersion,
		},
		hardwareProperties: {
			deviceType: d.deviceType,
			platform: d.platform ?? "iOS",
			reality: d.reality ?? "physical",
			udid: d.udid,
		},
		properties: {
			state: {
				bootState: "booted",
				developerModeStatus: developerMode === "enabled" ? { enabled: { mode: 1 } } : "disabled",
				name: d.name,
			},
		},
	};
}

export function devicectlJson(devices: Array<Record<string, unknown>>): string {
	return JSON.stringify({
		info: { commandType: "devicectl.list.devices", jsonVersion: 5, outcome: "success", version: "651.13.5" },
		result: { devices },
	});
}

/** A ready iPhone on the local network, a wired iPad with Developer Mode off, an unpaired phone, a simulator and a watch. */
export const DEVICECTL_LIST_MIXED = devicectlJson([
	devicectlEntry({
		udid: FAKE_IPHONE_UDID,
		name: "Test iPhone",
		deviceType: "iPhone",
		osVersion: "27.2",
		transportType: "localNetwork",
		tunnelState: "connected",
		tunnelIPAddress: "fd00:1234:5678::1",
	}),
	devicectlEntry({
		udid: FAKE_IPAD_UDID,
		name: "Test iPad",
		deviceType: "iPad",
		osVersion: "18.7.8",
		developerMode: "disabled",
		ddi: false,
	}),
	devicectlEntry({
		udid: FAKE_UNPAIRED_UDID,
		name: "Unpaired iPhone",
		deviceType: "iPhone",
		osVersion: "26.6",
		pairingState: "unpaired",
	}),
	devicectlEntry({
		udid: "5E5E5E5E-0000-4000-8000-000000000001",
		name: "iPhone 17",
		deviceType: "iPhone",
		osVersion: "26.5",
		reality: "simulated",
		transportType: "sameMachine",
	}),
	devicectlEntry({
		udid: "00008301-000A0B0C0D0E0F13",
		name: "Test Watch",
		deviceType: "appleWatch",
		platform: "watchOS",
		osVersion: "11.0",
	}),
]);

export const DEVICECTL_LIST_EMPTY = devicectlJson([]);

/** `devicectl device info lockState --json-output -`: unlocked, then behind a passcode. */
export const DEVICECTL_LOCKSTATE_UNLOCKED = JSON.stringify({
	info: { commandType: "devicectl.device.info.lockState", outcome: "success" },
	result: {
		deviceIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-000000000001",
		passcodeRequired: false,
		unlockedSinceBoot: true,
	},
});
export const DEVICECTL_LOCKSTATE_LOCKED = JSON.stringify({
	info: { commandType: "devicectl.device.info.lockState", outcome: "success" },
	result: { deviceIdentifier: "AAAAAAAA-BBBB-CCCC-DDDD-000000000001", passcodeRequired: true, unlockedSinceBoot: true },
});
