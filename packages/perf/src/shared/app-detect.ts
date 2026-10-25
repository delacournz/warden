export type IosRunningApp = { bundleId: string; pid: number };

/**
 * `simctl spawn <udid> launchctl list` rows are `PID  STATUS  LABEL`; an app is `UIKitApplication:<bundle>[0x…]`
 * and counts only with a numeric PID (`-` = loaded but not running).
 */
export function parseIosRunningApps(launchctlOutput: string): IosRunningApp[] {
	const apps: IosRunningApp[] = [];
	for (const line of launchctlOutput.split("\n")) {
		const m = /^\s*(\d+)\s+\S+\s+UIKitApplication:([^\s[]+)\[/.exec(line);
		if (m?.[1] && m[2]) apps.push({ bundleId: m[2], pid: Number(m[1]) });
	}
	return apps;
}

export type IosAppPick =
	| { kind: "app"; bundleId: string; pid: number }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" };

/** The app to profile: the one running non-Apple app. launchctl does not say which is frontmost, so several is ambiguous. */
export function pickIosApp(apps: readonly IosRunningApp[]): IosAppPick {
	const user = apps.filter((a) => !a.bundleId.startsWith("com.apple."));
	const [only, ...rest] = user;
	if (only === undefined) return { kind: "none" };
	if (rest.length === 0) return { kind: "app", bundleId: only.bundleId, pid: only.pid };
	return { kind: "ambiguous", candidates: user.map((a) => a.bundleId) };
}

export type ResumedActivity = { package: string; activity: string };

/** `dumpsys activity activities`: `mResumedActivity: ActivityRecord{… u0 <pkg>/<activity> t<id>}` (or `topResumedActivity=`). */
export function parseResumedActivity(dumpsys: string): ResumedActivity | undefined {
	const m =
		/(?:mResumedActivity|topResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{[^}]*?\su\d+\s+([\w.]+)\/(\S+)\s/.exec(
			dumpsys
		);
	return m?.[1] && m[2] ? { package: m[1], activity: m[2] } : undefined;
}

export type PackageFlags = { debuggable: boolean; profileable: boolean };

/** `dumpsys package <pkg>`: `flags=[ DEBUGGABLE … ]`; a `PROFILEABLE…` flag anywhere means profileable by shell. */
export function parsePackageFlags(dumpsysPackage: string): PackageFlags {
	const flags = /^\s*(?:pkgFlags|flags)=\[([^\]]*)\]/m.exec(dumpsysPackage)?.[1] ?? "";
	return { debuggable: /\bDEBUGGABLE\b/.test(flags), profileable: /PROFILEABLE/.test(dumpsysPackage) };
}
