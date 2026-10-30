import type { PermissionName, PermissionState, TextSize } from "@delacour/warden-core/conditions/conditions.types";
import type { LaunchSettings } from "@delacour/warden-core/conditions/launch-settings";
import { resolveTextSize } from "@delacour/warden-core/conditions/text-size";
import { type Exec, execError } from "@delacour/warden-core/exec";
import { badRequest, batteryProblem, localeProblem, pushProblem, timezoneProblem } from "../device-settings";
import type { A11yState, BatteryState, Driver, DriverResult, LaunchOptions } from "../driver.types";
import { driverErr } from "../errors";

/**
 * iOS simulator device settings over `xcrun simctl` (verified on a simulator): `privacy` for permissions, `ui` for
 * text size and contrast, `status_bar` for the battery, `push` for APNs payloads. A simulator has no per-device
 * timezone or locale, so those are staged and ride on the next launch of an app (`TZ` env, `-AppleLanguages` /
 * `-AppleLocale` args).
 */

const XCRUN = ["xcrun", "simctl"] as const;
const SIMCTL_MS = 15_000;
/** exit code of a call `Exec` killed at its timeout (SIGTERM) */
const KILLED_BY_TIMEOUT = 143;

/** Permission name to `simctl privacy` service; a name without one is skipped with the reason in `IOS_NO_SERVICE`. */
export const IOS_PRIVACY_SERVICE: Partial<Record<PermissionName, string>> = {
	location: "location",
	locationAlways: "location-always",
	photos: "photos",
	photosAdd: "photos-add",
	contacts: "contacts",
	contactsLimited: "contacts-limited",
	microphone: "microphone",
	calendar: "calendar",
	reminders: "reminders",
	motion: "motion",
	mediaLibrary: "media-library",
	siri: "siri",
};

export const IOS_NO_SERVICE: Partial<Record<PermissionName, string>> = {
	camera: "the simulator has no camera and simctl privacy has no camera service",
	notifications: "simctl privacy has no notifications service (it fails with 'Operation not permitted')",
};

const PRIVACY_ACTION: Record<PermissionState, string> = { granted: "grant", denied: "revoke", unset: "reset" };

export const privacyArgv = (udid: string, state: PermissionState, service: string, bundleId: string): string[] => [
	...XCRUN,
	"privacy",
	udid,
	PRIVACY_ACTION[state],
	service,
	bundleId,
];

export const contentSizeArgv = (udid: string, category: string): string[] => [
	...XCRUN,
	"ui",
	udid,
	"content_size",
	category,
];

export const contrastArgv = (udid: string, increased: boolean): string[] => [
	...XCRUN,
	"ui",
	udid,
	"increase_contrast",
	increased ? "enabled" : "disabled",
];

export const DEFAULT_CONTENT_SIZE = "large";

export function statusBarBatteryArgv(udid: string, op: { level?: number; charging?: boolean }): string[] {
	const flags: string[] = [];
	if (op.charging !== undefined) flags.push("--batteryState", op.charging ? "charging" : "discharging");
	if (op.level !== undefined) flags.push("--batteryLevel", String(op.level));
	return [...XCRUN, "status_bar", udid, "override", ...flags];
}

export const statusBarClearArgv = (udid: string): string[] => [...XCRUN, "status_bar", udid, "clear"];

/** `simctl push` reads the payload from stdin (`-`); a `sh -c` with positional args keeps it out of the command line quoting. */
export const pushArgv = (udid: string, bundleId: string, payload: unknown): string[] => [
	"sh",
	"-c",
	'printf %s "$1" | xcrun simctl push "$2" "$3" -',
	"sh",
	JSON.stringify(payload),
	udid,
	bundleId,
];

/** The launch env and args a staged timezone / locale becomes. */
export function launchExtras(settings: LaunchSettings): { env: Record<string, string>; args: string[] } {
	const env: Record<string, string> = settings.timezone === undefined ? {} : { TZ: settings.timezone };
	const args =
		settings.locale === undefined
			? []
			: ["-AppleLanguages", `(${settings.locale})`, "-AppleLocale", settings.locale.replace(/-/g, "_")];
	return { env, args };
}

/** `requested` with the staged timezone / locale merged in (the caller's own env and args win on a clash). */
export function withStagedSettings(
	requested: LaunchOptions | undefined,
	settings: LaunchSettings
): LaunchOptions | undefined {
	const { env, args } = launchExtras(settings);
	if (args.length === 0 && Object.keys(env).length === 0) return requested;
	return {
		...requested,
		env: { ...env, ...requested?.env },
		args: [...(requested?.args ?? []), ...args],
	};
}

export type StagedSettings = { read(): LaunchSettings; write(settings: LaunchSettings): string | undefined };

export type IosSettingsDeps = {
	udid: string;
	exec: Exec;
	/** the last app this driver launched */
	lastBundle: () => string | undefined;
	/** the session's app (`WARDEN_BUNDLE_ID`) when nothing was launched yet */
	defaultBundle?: string;
	/** where timezone / locale are staged between processes; absent: kept in this driver only */
	staged?: StagedSettings;
};

export type IosSettings = Pick<
	Driver,
	"permissions" | "timezone" | "locale" | "a11y" | "battery" | "memoryWarning" | "push"
> & {
	/** the staged timezone / locale, for `app.launch` to merge into a launch */
	launchSettings(): LaunchSettings;
};

export function createIosSettings(deps: IosSettingsDeps): IosSettings {
	const { udid, exec } = deps;
	let memoryStaged: LaunchSettings = {};
	const stagedNow = (): LaunchSettings => (deps.staged ? deps.staged.read() : memoryStaged);
	const stage = (next: LaunchSettings): string | undefined => {
		if (deps.staged) return deps.staged.write(next);
		memoryStaged = next;
		return undefined;
	};
	const resolveBundle = (explicit: string | undefined, what: string) => {
		const bundleId = explicit ?? deps.lastBundle() ?? deps.defaultBundle;
		return bundleId === undefined
			? driverErr("E_BAD_REQUEST", `${what} needs an app: pass a bundle id (nothing was launched yet)`)
			: { bundleId };
	};

	/** `retryHung`: a call killed at the timeout runs once more (seen: `simctl privacy` hanging on a sim that just booted) */
	async function simctl(argv: string[], retryHung = false): DriverResult<void> {
		let res = await exec(argv, { timeoutMs: SIMCTL_MS });
		if (retryHung && res.exitCode === KILLED_BY_TIMEOUT) res = await exec(argv, { timeoutMs: SIMCTL_MS });
		return res.exitCode === 0
			? { success: true, data: undefined }
			: driverErr("E_IO", execError(argv, res), { detail: { udid } });
	}

	return {
		launchSettings: stagedNow,
		async permissions(grants, opts) {
			const app = resolveBundle(opts?.bundleId, "permissions");
			if ("success" in app) return app;
			const { bundleId } = app;
			const applied: { permission: PermissionName; state: PermissionState }[] = [];
			const skipped: { permission: PermissionName; reason: string }[] = [];
			for (const [name, state] of Object.entries(grants) as [PermissionName, PermissionState][]) {
				const service = IOS_PRIVACY_SERVICE[name];
				if (service === undefined) {
					skipped.push({ permission: name, reason: IOS_NO_SERVICE[name] ?? "no simctl privacy service" });
					continue;
				}
				const done = await simctl(privacyArgv(udid, state, service, bundleId), true);
				if (!done.success) return done;
				applied.push({ permission: name, state });
			}
			if (applied.length === 0 && skipped.length > 0) {
				return driverErr("E_UNSUPPORTED", skipped.map((s) => `${s.permission}: ${s.reason}`).join("; "));
			}
			return { success: true, data: { bundleId, applied, skipped } };
		},
		async timezone(tz) {
			if (tz !== null) {
				const bad = badRequest(timezoneProblem(tz));
				if (bad) return bad;
			}
			const { timezone: _drop, ...rest } = stagedNow();
			const failed = stage(tz === null ? rest : { ...rest, timezone: tz });
			if (failed) return driverErr("E_IO", failed);
			return { success: true, data: tz === null ? {} : { timezone: tz, appliesOnLaunch: true } };
		},
		async locale(tag, opts) {
			if (tag !== null) {
				const bad = badRequest(localeProblem(tag));
				if (bad) return bad;
			}
			const { locale: _drop, ...rest } = stagedNow();
			const failed = stage(tag === null ? rest : { ...rest, locale: tag });
			if (failed) return driverErr("E_IO", failed);
			const bundleId = opts?.bundleId ?? deps.lastBundle() ?? deps.defaultBundle;
			return {
				success: true,
				data: {
					...(tag === null ? {} : { locale: tag, appliesOnLaunch: true as const }),
					...(bundleId === undefined ? {} : { bundleId }),
				},
			};
		},
		async a11y(op) {
			const applied: string[] = [];
			const skipped: { setting: string; reason: string }[] = [];
			const size = op === null ? undefined : op.textSize;
			if (op === null || size !== undefined) {
				const resolved = op === null ? undefined : resolveTextSize(size as TextSize);
				if (resolved && !resolved.success) return driverErr("E_BAD_REQUEST", resolved.error);
				const done = await simctl(contentSizeArgv(udid, resolved ? resolved.data.category : DEFAULT_CONTENT_SIZE));
				if (!done.success) return done;
				applied.push("textSize");
			}
			if (op === null || op.contrast !== undefined) {
				const done = await simctl(contrastArgv(udid, op?.contrast === "increased"));
				if (!done.success) return done;
				applied.push("contrast");
			}
			if (op?.boldText !== undefined) {
				skipped.push({ setting: "boldText", reason: "iOS has no simctl switch for bold text" });
			}
			if (op?.reduceMotion !== undefined) {
				skipped.push({ setting: "reduceMotion", reason: "iOS has no simctl switch for reduce motion" });
			}
			if (applied.length === 0 && skipped.length > 0) {
				return driverErr("E_UNSUPPORTED", skipped.map((s) => `${s.setting}: ${s.reason}`).join("; "));
			}
			return { success: true, data: { applied, skipped, notes: [] } satisfies A11yState };
		},
		async battery(op) {
			if (op === null) {
				const done = await simctl(statusBarClearArgv(udid));
				return done.success ? { success: true, data: { cosmetic: true } satisfies BatteryState } : done;
			}
			const bad = badRequest(batteryProblem(op.level));
			if (bad) return bad;
			if (op.level === undefined && op.charging === undefined) {
				return driverErr("E_BAD_REQUEST", "battery needs a level, charging, or both");
			}
			const done = await simctl(statusBarBatteryArgv(udid, op));
			if (!done.success) return done;
			return {
				success: true,
				data: {
					...(op.level === undefined ? {} : { level: op.level }),
					...(op.charging === undefined ? {} : { charging: op.charging }),
					cosmetic: true,
				},
			};
		},
		async memoryWarning() {
			return driverErr(
				"E_UNSUPPORTED",
				"no way to deliver a memory warning to an iOS app was found: `notifyutil -p com.apple.system.lowmemory` is accepted but a UIKit app never receives UIApplicationDidReceiveMemoryWarning (verified); use Simulator > Debug > Simulate Memory Warning by hand"
			);
		},
		async push(payload, opts) {
			const bad = badRequest(pushProblem(payload));
			if (bad) return bad;
			const app = resolveBundle(opts?.bundleId, "push");
			if ("success" in app) return app;
			return simctl(pushArgv(udid, app.bundleId, payload));
		},
	};
}
