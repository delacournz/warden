/** `xcrun xctrace version` → `27.1` (from `xctrace version 27.1 (27A9275)`). */
export function parseXctraceVersion(text: string): string | undefined {
	return /xctrace version\s+(\d+(?:\.\d+)*)/.exec(text)?.[1];
}

export type XcodeVersion = { major: number; minor: number; patch: number; text: string };

/** `xcodebuild -version` → `Xcode 26.4.1` as numbers. */
export function parseXcodeVersion(text: string): XcodeVersion | undefined {
	const m = /^Xcode\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/m.exec(text);
	if (m?.[1] === undefined) return undefined;
	const major = Number(m[1]);
	const minor = Number(m[2] ?? 0);
	const patch = Number(m[3] ?? 0);
	return { major, minor, patch, text: [major, minor, ...(m[3] === undefined ? [] : [patch])].join(".") };
}

/** `adb version` → `1.0.41`. */
export function parseAdbVersion(text: string): string | undefined {
	return /Android Debug Bridge version\s+(\S+)/.exec(text)?.[1];
}

/** Xcode 26.4+ deadlocks `xctrace record --device`: profile with `--all-processes` and filter by pid instead. */
export function xctraceDeviceDeadlock(version: XcodeVersion): boolean {
	return version.major > 26 || (version.major === 26 && version.minor >= 4);
}

export type DeviceTools = { perfetto: boolean; simpleperf: boolean };

/** `adb shell which perfetto simpleperf` prints the path of each tool that exists. */
export function parseDeviceTools(whichOutput: string): DeviceTools {
	const names = new Set(
		whichOutput
			.split("\n")
			.map((line) => line.trim().split("/").at(-1))
			.filter((name): name is string => name !== undefined && name !== "")
	);
	return { perfetto: names.has("perfetto"), simpleperf: names.has("simpleperf") };
}
