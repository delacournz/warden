/**
 * Trimmed real `xcrun simctl … -j` output (Xcode 26, iOS 26.x runtimes) for provider tests.
 * Shapes captured from `simctl list devices available -j`, `list runtimes -j`, `list devicetypes -j`.
 */

export type FixtureSim = {
	udid: string;
	name: string;
	state: "Booted" | "Shutdown" | "Booting";
	deviceTypeIdentifier?: string;
	isAvailable?: boolean;
	/** ISO timestamp; omitted = never booted */
	lastBootedAt?: string;
	dataPathSize?: number;
};

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/** Build a `simctl list devices available -j` document from a runtime-suffix → sims map. */
export function simctlDevicesJson(byRuntime: Record<string, FixtureSim[]>): string {
	const devices = Object.fromEntries(
		Object.entries(byRuntime).map(([runtime, sims]) => [
			`${RUNTIME_PREFIX}${runtime}`,
			sims.map((s) => ({
				dataPath: `/Users/me/Library/Developer/CoreSimulator/Devices/${s.udid}/data`,
				dataPathSize: s.dataPathSize ?? 18337792,
				...(s.lastBootedAt !== undefined ? { lastBootedAt: s.lastBootedAt } : {}),
				logPath: `/Users/me/Library/Logs/CoreSimulator/${s.udid}`,
				udid: s.udid,
				isAvailable: s.isAvailable ?? true,
				deviceTypeIdentifier: s.deviceTypeIdentifier ?? "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
				state: s.state,
				name: s.name,
			})),
		])
	);
	return JSON.stringify({ devices }, null, 2);
}

export const SIMCTL_DEVICES_JSON = `{
  "devices" : {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3" : [

    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5" : [
      {
        "lastBootedAt" : "2026-09-28T01:57:04Z",
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/171CB1CD-F9C2-44F8-9928-2D99F7A8FA8E\\/data",
        "dataPathSize" : 4604567552,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/171CB1CD-F9C2-44F8-9928-2D99F7A8FA8E",
        "udid" : "171CB1CD-F9C2-44F8-9928-2D99F7A8FA8E",
        "isAvailable" : true,
        "logPathSize" : 598016,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        "state" : "Shutdown",
        "name" : "iPhone 17 Pro"
      },
      {
        "lastBootedAt" : "2026-09-29T03:37:42Z",
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/978BAD6B-EEB8-4A54-9D5F-D17280D12AA5\\/data",
        "dataPathSize" : 3999055872,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/978BAD6B-EEB8-4A54-9D5F-D17280D12AA5",
        "udid" : "978BAD6B-EEB8-4A54-9D5F-D17280D12AA5",
        "isAvailable" : true,
        "logPathSize" : 135168,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        "state" : "Booted",
        "name" : "iPhone 17"
      },
      {
        "lastBootedAt" : "2026-09-28T08:50:51Z",
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/96C4ADE9-DF2A-4285-9D38-C79385A1A344\\/data",
        "dataPathSize" : 2394550272,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/96C4ADE9-DF2A-4285-9D38-C79385A1A344",
        "udid" : "96C4ADE9-DF2A-4285-9D38-C79385A1A344",
        "isAvailable" : true,
        "logPathSize" : 380928,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        "state" : "Shutdown",
        "name" : "warden-iphone-17-1"
      },
      {
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/239B5F29-73AB-4BE6-8865-BEDCB9D17FB6\\/data",
        "dataPathSize" : 2082213888,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/239B5F29-73AB-4BE6-8865-BEDCB9D17FB6",
        "udid" : "239B5F29-73AB-4BE6-8865-BEDCB9D17FB6",
        "isAvailable" : true,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        "state" : "Booting",
        "name" : "warden-iphone-17-2"
      },
      {
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/0D1E2F30-0000-4000-8000-000000000001\\/data",
        "dataPathSize" : 18337792,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/0D1E2F30-0000-4000-8000-000000000001",
        "udid" : "0D1E2F30-0000-4000-8000-000000000001",
        "isAvailable" : false,
        "availabilityError" : "runtime profile not found",
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        "state" : "Shutdown",
        "name" : "broken-sim"
      },
      {
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/A1B2C3D4-0000-4000-8000-00000000000A\\/data",
        "dataPathSize" : 18337792,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/A1B2C3D4-0000-4000-8000-00000000000A",
        "udid" : "A1B2C3D4-0000-4000-8000-00000000000A",
        "isAvailable" : true,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
        "state" : "Shutdown",
        "name" : "iPad Pro 13-inch (M5)"
      }
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0" : [
      {
        "dataPath" : "\\/Users\\/me\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/F00DF00D-0000-4000-8000-000000000001\\/data",
        "dataPathSize" : 18337792,
        "logPath" : "\\/Users\\/me\\/Library\\/Logs\\/CoreSimulator\\/F00DF00D-0000-4000-8000-000000000001",
        "udid" : "F00DF00D-0000-4000-8000-000000000001",
        "isAvailable" : true,
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm",
        "state" : "Shutdown",
        "name" : "Apple Watch Series 11 (46mm)"
      }
    ]
  }
}`;

export const SIMCTL_RUNTIMES_JSON = `{
  "runtimes" : [
    {
      "isAvailable" : true,
      "version" : "26.1",
      "isInternal" : false,
      "buildversion" : "23B86",
      "supportedArchitectures" : [ "arm64" ],
      "supportedDeviceTypes" : [
        { "name" : "iPhone 17 Pro", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "productFamily" : "iPhone" },
        { "name" : "iPhone 17", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "productFamily" : "iPhone" }
      ],
      "identifier" : "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
      "platform" : "iOS",
      "name" : "iOS 26.1"
    },
    {
      "isAvailable" : true,
      "version" : "26.5",
      "isInternal" : false,
      "buildversion" : "23F77",
      "supportedArchitectures" : [ "arm64" ],
      "supportedDeviceTypes" : [
        { "name" : "iPhone 17 Pro", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "productFamily" : "iPhone" },
        { "name" : "iPhone 17", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "productFamily" : "iPhone" }
      ],
      "identifier" : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      "platform" : "iOS",
      "name" : "iOS 26.5"
    },
    {
      "isAvailable" : true,
      "version" : "26.3.1",
      "isInternal" : false,
      "buildversion" : "23D8133",
      "supportedArchitectures" : [ "arm64" ],
      "supportedDeviceTypes" : [
        { "name" : "iPhone 17", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "productFamily" : "iPhone" }
      ],
      "identifier" : "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "platform" : "iOS",
      "name" : "iOS 26.3"
    },
    {
      "isAvailable" : false,
      "version" : "27.0",
      "isInternal" : false,
      "buildversion" : "24A1",
      "supportedArchitectures" : [ "arm64" ],
      "supportedDeviceTypes" : [],
      "identifier" : "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      "platform" : "iOS",
      "name" : "iOS 27.0"
    },
    {
      "isAvailable" : true,
      "version" : "26.0",
      "isInternal" : false,
      "buildversion" : "23R1",
      "supportedArchitectures" : [ "arm64" ],
      "supportedDeviceTypes" : [],
      "identifier" : "com.apple.CoreSimulator.SimRuntime.watchOS-26-0",
      "platform" : "watchOS",
      "name" : "watchOS 26.0"
    }
  ]
}`;

export const SIMCTL_DEVICETYPES_JSON = `{
  "devicetypes" : [
    {
      "productFamily" : "iPhone",
      "bundlePath" : "\\/Library\\/Developer\\/CoreSimulator\\/Profiles\\/DeviceTypes\\/iPhone 17 Pro.simdevicetype",
      "maxRuntimeVersion" : 4294967295,
      "maxRuntimeVersionString" : "65535.255.255",
      "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      "modelIdentifier" : "iPhone18,1",
      "minRuntimeVersionString" : "26.0.0",
      "minRuntimeVersion" : 1703936,
      "name" : "iPhone 17 Pro"
    },
    {
      "productFamily" : "iPhone",
      "bundlePath" : "\\/Library\\/Developer\\/CoreSimulator\\/Profiles\\/DeviceTypes\\/iPhone 17.simdevicetype",
      "maxRuntimeVersion" : 4294967295,
      "maxRuntimeVersionString" : "65535.255.255",
      "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      "modelIdentifier" : "iPhone18,3",
      "minRuntimeVersionString" : "26.0.0",
      "minRuntimeVersion" : 1703936,
      "name" : "iPhone 17"
    },
    {
      "productFamily" : "iPad",
      "bundlePath" : "\\/Library\\/Developer\\/CoreSimulator\\/Profiles\\/DeviceTypes\\/iPad Pro 13-inch (M5).simdevicetype",
      "maxRuntimeVersion" : 4294967295,
      "maxRuntimeVersionString" : "65535.255.255",
      "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
      "modelIdentifier" : "iPad17,3",
      "minRuntimeVersionString" : "26.0.0",
      "minRuntimeVersion" : 1703936,
      "name" : "iPad Pro 13-inch (M5)"
    }
  ]
}`;

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One machine with every kind of sim `warden sims` judges, booted/used relative to `now`. Pair with
 * `MIXED_SIMS_RECORDS` (warden's store) and a lease on `W-LEASED`.
 */
export function mixedSims(now: number): Record<string, FixtureSim[]> {
	const ago = (days: number) => iso(now - days * DAY_MS);
	return {
		"iOS-17-0": [{ udid: "F-GONE", name: "iPhone 15", state: "Shutdown", isAvailable: false, dataPathSize: 1_000 }],
		"iOS-18-6": [{ udid: "F-OLD", name: "iPhone 16", state: "Shutdown", lastBootedAt: ago(2), dataPathSize: 2_000 }],
		"iOS-26-5": [
			{ udid: "W-IDLE", name: "warden-iphone-17-1", state: "Shutdown", lastBootedAt: ago(20), dataPathSize: 3_000 },
			{ udid: "W-RECENT", name: "warden-iphone-17-2", state: "Shutdown", lastBootedAt: ago(1), dataPathSize: 4_000 },
			{ udid: "W-ORPHAN", name: "warden-iphone-17-3", state: "Shutdown", dataPathSize: 5_000 },
			{ udid: "W-BOOTED", name: "warden-iphone-17-4", state: "Booted", lastBootedAt: ago(30), dataPathSize: 6_000 },
			{ udid: "W-LEASED", name: "warden-iphone-17-5", state: "Shutdown", lastBootedAt: ago(30), dataPathSize: 7_000 },
			{ udid: "F-STALE", name: "iPhone Air", state: "Shutdown", lastBootedAt: ago(45), dataPathSize: 8_000 },
			{ udid: "F-FRESH", name: "iPhone 16", state: "Shutdown", lastBootedAt: ago(1), dataPathSize: 9_000 },
			{ udid: "F-DUP-A", name: "iPhone 17", state: "Shutdown", lastBootedAt: ago(3), dataPathSize: 10_000 },
			{ udid: "F-DUP-B", name: "iPhone 17", state: "Shutdown", lastBootedAt: ago(1), dataPathSize: 11_000 },
			{
				udid: "G-GOLD",
				name: "warden-golden-iphone-17-0123456789",
				state: "Shutdown",
				isAvailable: false,
				dataPathSize: 12_000,
			},
		],
	};
}

/** Warden's store records for `mixedSims` (`W-ORPHAN` deliberately has none): udid → days since last use. */
export const MIXED_SIMS_RECORDS: Record<string, number> = {
	"W-IDLE": 20,
	"W-RECENT": 1,
	"W-BOOTED": 30,
	"W-LEASED": 30,
};
