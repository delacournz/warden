import type { PermissionName, PermissionState, TextSize } from "@delacour/warden-config/conditions.types";
import { textSizes } from "@delacour/warden-config/text-size";
import { deviceSettings } from "@delacour/warden-driver/device-settings";
import type {
	A11yOp,
	A11yState,
	BatteryOp,
	BatteryState,
	Driver,
	DriverResult,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { AdbSession } from "./adb-session";
import { androidArgv } from "./android-argv";

/**
 * Android device settings over the resident adb shell (each mechanism verified on an emulator): `pm grant|revoke`
 * for permissions, `cmd alarm set-timezone`, per-app `cmd locale set-app-locales` (API 33+), `settings put` for
 * font scale and bold text, `dumpsys battery`, `am send-trim-memory`. No contrast or reduce-motion switch exists in
 * the shell (the animation scales are the driver's own), so those are skipped, not faked.
 */

const ANDROID = "android.permission.";

/** Permission name to the manifest permissions it covers; a name absent here is skipped with the reason in `ANDROID_NO_PERMISSION`. */
export const ANDROID_PERMISSIONS: Partial<Record<PermissionName, readonly string[]>> = {
	location: [`${ANDROID}ACCESS_FINE_LOCATION`, `${ANDROID}ACCESS_COARSE_LOCATION`],
	locationAlways: [`${ANDROID}ACCESS_BACKGROUND_LOCATION`],
	camera: [`${ANDROID}CAMERA`],
	photos: [`${ANDROID}READ_MEDIA_IMAGES`, `${ANDROID}READ_MEDIA_VIDEO`, `${ANDROID}READ_EXTERNAL_STORAGE`],
	contacts: [`${ANDROID}READ_CONTACTS`, `${ANDROID}WRITE_CONTACTS`],
	notifications: [`${ANDROID}POST_NOTIFICATIONS`],
	microphone: [`${ANDROID}RECORD_AUDIO`],
	calendar: [`${ANDROID}READ_CALENDAR`, `${ANDROID}WRITE_CALENDAR`],
	motion: [`${ANDROID}ACTIVITY_RECOGNITION`],
	mediaLibrary: [`${ANDROID}READ_MEDIA_AUDIO`],
};

export const ANDROID_NO_PERMISSION: Partial<Record<PermissionName, string>> = {
	photosAdd: "Android has no add-only photo permission",
	contactsLimited: "Android has no limited contacts permission",
	reminders: "Android has no reminders permission",
	siri: "Android has no Siri",
};

export const TIMEZONE_PROP_ARGV: readonly string[] = ["getprop", "persist.sys.timezone"];
export const BOLD_TEXT_ADJUSTMENT = 300;
export const BATTERY_RESET_ARGV: readonly string[] = ["dumpsys", "battery", "reset"];

/** Device shell argv builders for the settings ops. */
export class AndroidSettingsArgv {
	permissionArgv(state: PermissionState, pkg: string, permission: string): string[] {
		return ["pm", state === "granted" ? "grant" : "revoke", pkg, permission];
	}

	/** `unset` also clears the flags a user choice sets, so the app is asked again. */
	clearPermissionFlagsArgv(pkg: string, permission: string): string[] {
		return ["pm", "clear-permission-flags", pkg, permission, "user-set", "user-fixed"];
	}

	setTimezoneArgv(tz: string): string[] {
		return ["cmd", "alarm", "set-timezone", tz];
	}

	setAppLocaleArgv(pkg: string, tag: string | null): string[] {
		return ["cmd", "locale", "set-app-locales", pkg, "--locales", tag ?? ""];
	}

	getAppLocaleArgv(pkg: string): string[] {
		return ["cmd", "locale", "get-app-locales", pkg];
	}

	settingGetArgv(table: "system" | "secure", key: string): string[] {
		return ["settings", "get", table, key];
	}

	trimMemoryArgv(pkg: string): string[] {
		return ["am", "send-trim-memory", pkg, "RUNNING_CRITICAL"];
	}

	batteryArgvs(op: { level?: number; charging?: boolean }): string[][] {
		const cmds: string[][] = [];
		if (op.charging === true)
			cmds.push(["dumpsys", "battery", "set", "ac", "1"], ["dumpsys", "battery", "set", "status", "2"]);
		if (op.charging === false)
			cmds.push(["dumpsys", "battery", "unplug"], ["dumpsys", "battery", "set", "status", "3"]);
		if (op.level !== undefined) cmds.push(["dumpsys", "battery", "set", "level", String(op.level)]);
		return cmds;
	}
}

export const androidSettingsArgv = new AndroidSettingsArgv();

/** The "not a declared permission" family of `pm grant` failures: the app simply does not use it. */
const NOT_DECLARED = /has not requested permission|Unknown permission|not a changeable permission/i;

export const APP_LOCALES_MIN_SDK = 33;
const SETTING_ATTEMPTS = 3;
const SETTING_SETTLE_MS = 400;

export type AndroidSettingsDeps = {
	session: AdbSession;
	serial: string;
	/** the session's app package, used when an op names none */
	appPackage?: string;
	/** wait between a settings write and its read-back (default `Bun.sleep`) */
	sleep?: (ms: number) => Promise<void>;
	/** the host's timezone, restored on `timezone(null)` when no previous one is given (default: `Intl`) */
	hostTimezone?: () => string;
};

/** The driver ops the settings class provides. */
export type AndroidSettingsOps = Pick<
	Driver,
	"permissions" | "timezone" | "locale" | "a11y" | "battery" | "memoryWarning" | "push"
>;

type Shelled = { ok: boolean; stdout: string; failure: string | undefined };

/** Each op needs of the device: a shell that reports, one that must succeed, the app, the API level. */
export class AndroidSettings {
	constructor(private readonly deps: AndroidSettingsDeps) {}

	/** The ops as a plain object (what the driver spreads into itself). */
	ops(): AndroidSettingsOps {
		return {
			permissions: this.permissions,
			timezone: this.timezone,
			locale: this.locale,
			a11y: this.a11y,
			battery: this.battery,
			memoryWarning: this.memoryWarning,
			push: this.push,
		};
	}

	readonly permissions: Driver["permissions"] = async (grants, opts) => {
		const app = this.packageOf(opts?.bundleId, "permissions");
		if ("success" in app) return app;
		const { bundleId } = app;
		const applied: { permission: PermissionName; state: PermissionState }[] = [];
		const skipped: { permission: PermissionName; reason: string }[] = [];
		for (const [name, state] of Object.entries(grants) as [PermissionName, PermissionState][]) {
			const done = await this.changeNamed(bundleId, name, state);
			if (!done.success) return done;
			if (done.data === undefined) applied.push({ permission: name, state });
			else skipped.push({ permission: name, reason: done.data });
		}
		if (applied.length === 0 && skipped.length > 0) {
			return this.unsupported(skipped.map((s) => ({ name: s.permission, reason: s.reason })));
		}
		return { success: true, data: { bundleId, applied, skipped } };
	};

	readonly timezone: Driver["timezone"] = async (tz, opts) => {
		const { serial } = this.deps;
		if (!serial.startsWith("emulator-")) {
			return driverErrors.err("E_UNSUPPORTED", `timezone changes need an emulator; ${serial} is not one`);
		}
		const bad = tz === null ? undefined : deviceSettings.badRequest(deviceSettings.timezoneProblem(tz));
		if (bad) return bad;
		const before = (await this.shell(TIMEZONE_PROP_ARGV)).stdout.trim();
		const target =
			tz ?? opts?.previous ?? this.deps.hostTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const set = await this.must(androidSettingsArgv.setTimezoneArgv(target));
		if (!set.success) return set;
		const after = (await this.shell(TIMEZONE_PROP_ARGV)).stdout.trim();
		if (after !== target) {
			return driverErrors.err("E_IO", `the device timezone is "${after}" after setting "${target}"`, {
				detail: { serial },
			});
		}
		return {
			success: true,
			data: { ...(tz === null ? {} : { timezone: tz }), ...(before === "" ? {} : { previous: before }) },
		};
	};

	readonly locale: Driver["locale"] = async (tag, opts) => {
		const app = this.packageOf(opts?.bundleId, "locale");
		if ("success" in app) return app;
		const { bundleId } = app;
		const bad = tag === null ? undefined : deviceSettings.badRequest(deviceSettings.localeProblem(tag));
		if (bad) return bad;
		const level = await this.sdk();
		if (level < APP_LOCALES_MIN_SDK) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				`per-app locales need Android 13 (API ${APP_LOCALES_MIN_SDK}); this device is API ${level}`
			);
		}
		const set = await this.must(androidSettingsArgv.setAppLocaleArgv(bundleId, tag));
		if (!set.success) return set;
		const read = await this.shell(androidSettingsArgv.getAppLocaleArgv(bundleId));
		if (tag !== null && !read.stdout.includes(`[${tag}`)) {
			return driverErrors.err("E_IO", `${bundleId} reports ${read.stdout.trim()} after setting ${tag}`, {
				detail: { serial: this.deps.serial },
			});
		}
		return { success: true, data: { ...(tag === null ? {} : { locale: tag }), bundleId } };
	};

	readonly a11y: Driver["a11y"] = async (op) => {
		const applied: string[] = [];
		const skipped: { setting: string; reason: string }[] = [];
		let notes: string[] = [];
		if (op === null || op.textSize !== undefined) {
			const font = this.fontScaleOf(op?.textSize);
			if ("success" in font) return font;
			notes = font.notes;
			const done = await this.putSetting("system", "font_scale", String(font.scale));
			if (!done.success) return done;
			applied.push("textSize");
		}
		if (op === null || op.boldText !== undefined) {
			const done = await this.putSetting(
				"secure",
				"font_weight_adjustment",
				String(op?.boldText === true ? BOLD_TEXT_ADJUSTMENT : 0)
			);
			if (!done.success) return done;
			applied.push("boldText");
		}
		skipped.push(...this.a11ySkips(op));
		if (applied.length === 0 && skipped.length > 0) {
			return this.unsupported(skipped.map((s) => ({ name: s.setting, reason: s.reason })));
		}
		return { success: true, data: { applied, skipped, notes } satisfies A11yState };
	};

	readonly battery: Driver["battery"] = async (op) => {
		const { serial } = this.deps;
		if (!serial.startsWith("emulator-")) {
			return driverErrors.err("E_UNSUPPORTED", `battery changes need an emulator; ${serial} is not one`);
		}
		if (op === null) {
			const done = await this.must(BATTERY_RESET_ARGV);
			return done.success ? { success: true, data: { cosmetic: false } satisfies BatteryState } : done;
		}
		const bad = this.batteryRequestProblem(op);
		if (bad) return bad;
		for (const cmd of androidSettingsArgv.batteryArgvs(op)) {
			const done = await this.must(cmd);
			if (!done.success) return done;
		}
		return {
			success: true,
			data: {
				...(op.level === undefined ? {} : { level: op.level }),
				...(op.charging === undefined ? {} : { charging: op.charging }),
				cosmetic: false,
			},
		};
	};

	readonly memoryWarning: Driver["memoryWarning"] = async (opts) => {
		const app = this.packageOf(opts?.bundleId, "memoryWarning");
		if ("success" in app) return app;
		const sent = await this.shell(androidSettingsArgv.trimMemoryArgv(app.bundleId));
		if (sent.ok && !/Exception/.test(sent.stdout)) return { success: true, data: undefined };
		if (/Unknown process/.test(sent.stdout)) {
			return driverErrors.err(
				"E_APP_UNAVAILABLE",
				`${app.bundleId} is not running, so there is no process to send the trim to`
			);
		}
		return driverErrors.err("E_IO", sent.failure ?? sent.stdout.trim(), { detail: { serial: this.deps.serial } });
	};

	readonly push: Driver["push"] = async () =>
		driverErrors.err(
			"E_UNSUPPORTED",
			"push notifications through the shell are iOS only (`simctl push`); Android needs FCM"
		);

	private unsupported(parts: readonly { name: string; reason: string }[]) {
		return driverErrors.err("E_UNSUPPORTED", parts.map((s) => `${s.name}: ${s.reason}`).join("; "));
	}

	/** Run one name's manifest permissions; `changed` counts those the app declares. */
	private async changePermission(
		bundleId: string,
		manifest: readonly string[],
		state: PermissionState
	): DriverResult<number> {
		let changed = 0;
		for (const permission of manifest) {
			const done = await this.shell(
				androidSettingsArgv.permissionArgv(state === "unset" ? "denied" : state, bundleId, permission)
			);
			if (!done.ok) {
				if (NOT_DECLARED.test(done.stdout)) continue;
				return driverErrors.err("E_IO", done.failure ?? permission, { detail: { serial: this.deps.serial } });
			}
			if (state === "unset") await this.shell(androidSettingsArgv.clearPermissionFlagsArgv(bundleId, permission));
			changed++;
		}
		return { success: true, data: changed };
	}

	/** One permission name: undefined when applied, else why it was skipped. */
	private async changeNamed(
		bundleId: string,
		name: PermissionName,
		state: PermissionState
	): DriverResult<string | undefined> {
		const manifest = ANDROID_PERMISSIONS[name];
		if (manifest === undefined) return { success: true, data: ANDROID_NO_PERMISSION[name] ?? "no Android permission" };
		const changed = await this.changePermission(bundleId, manifest, state);
		if (!changed.success) return changed;
		return {
			success: true,
			data: changed.data === 0 ? `${bundleId} does not declare ${manifest.join(" or ")}` : undefined,
		};
	}

	/** The font scale an a11y text size means on Android, with a note when it was clamped. */
	private fontScaleOf(
		size: TextSize | undefined
	): { scale: number; notes: string[] } | ReturnType<typeof driverErrors.err> {
		if (size === undefined) return { scale: 1, notes: [] };
		const resolved = textSizes.resolveTextSize(size);
		if (!resolved.success) return driverErrors.err("E_BAD_REQUEST", resolved.error);
		const scale = textSizes.androidFontScale(resolved.data.scale);
		return {
			scale,
			notes:
				scale === resolved.data.scale
					? []
					: [`font scale ${resolved.data.scale} clamped to ${scale} (Android's range)`],
		};
	}

	/** Settings with no shell mechanism on Android, for the ones `op` asks for. */
	private a11ySkips(op: A11yOp | null): { setting: string; reason: string }[] {
		const skipped: { setting: string; reason: string }[] = [];
		if (op?.contrast !== undefined) {
			skipped.push({ setting: "contrast", reason: "Android has no shell switch for contrast that takes effect" });
		}
		if (op?.reduceMotion !== undefined) {
			skipped.push({
				setting: "reduceMotion",
				reason: "Android's closest setting is the animation scales, which warden's driver manages itself",
			});
		}
		return skipped;
	}

	private batteryRequestProblem(op: BatteryOp) {
		const bad = deviceSettings.badRequest(deviceSettings.batteryProblem(op.level));
		if (bad) return bad;
		return androidSettingsArgv.batteryArgvs(op).length === 0
			? driverErrors.err("E_BAD_REQUEST", "battery needs a level, charging, or both")
			: undefined;
	}

	private async shell(argv: readonly string[]): Promise<Shelled> {
		const res = await this.deps.session.run(androidArgv.shellCommand(argv));
		if (!res.success) return { ok: false, stdout: "", failure: res.error.message };
		const ok = res.data.exitCode === 0;
		return {
			ok,
			stdout: res.data.stdout,
			failure: ok ? undefined : `${argv.join(" ")}: ${res.data.stdout.trim() || `exit ${res.data.exitCode}`}`,
		};
	}

	private async must(argv: readonly string[]): DriverResult<string> {
		const done = await this.shell(argv);
		return done.ok
			? { success: true, data: done.stdout }
			: driverErrors.err("E_IO", done.failure ?? argv.join(" "), { detail: { serial: this.deps.serial } });
	}

	/** `settings put`, then read back: a font change makes the system write its own value a moment later, so a put is repeated until it holds */
	private async putSetting(table: "system" | "secure", key: string, value: string): DriverResult<string> {
		const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
		let last = "";
		for (let attempt = 0; attempt < SETTING_ATTEMPTS; attempt++) {
			const put = await this.must(["settings", "put", table, key, value]);
			if (!put.success) return put;
			await sleep(SETTING_SETTLE_MS);
			last = (await this.shell(androidSettingsArgv.settingGetArgv(table, key))).stdout.trim();
			// an empty read (a shell that does not answer `get`) cannot contradict the write
			if (last === "" || Number(last) === Number(value)) return put;
		}
		return driverErrors.err("E_IO", `${table} ${key} reads ${last} after setting ${value}`, {
			detail: { serial: this.deps.serial },
		});
	}

	private packageOf(
		explicit: string | undefined,
		what: string
	): { bundleId: string } | ReturnType<typeof driverErrors.err> {
		const bundleId = explicit ?? this.deps.appPackage;
		return bundleId === undefined
			? driverErrors.err("E_BAD_REQUEST", `${what} needs an app: pass a package name`)
			: { bundleId };
	}

	private async sdk(): Promise<number> {
		const out = await this.shell(["getprop", "ro.build.version.sdk"]);
		return Number(out.stdout.trim()) || 0;
	}
}
