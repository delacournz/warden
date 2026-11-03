import type { PermissionName, PermissionState, TextSize } from "@delacour/warden-core/conditions/conditions.types";
import { androidFontScale, resolveTextSize } from "@delacour/warden-core/conditions/text-size";
import { badRequest, batteryProblem, localeProblem, timezoneProblem } from "../device-settings";
import type { A11yOp, A11yState, BatteryOp, BatteryState, Driver, DriverResult } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { shellCommand } from "./android-argv";

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

export const permissionArgv = (state: PermissionState, pkg: string, permission: string): string[] => [
	"pm",
	state === "granted" ? "grant" : "revoke",
	pkg,
	permission,
];

/** `unset` also clears the flags a user choice sets, so the app is asked again. */
export const clearPermissionFlagsArgv = (pkg: string, permission: string): string[] => [
	"pm",
	"clear-permission-flags",
	pkg,
	permission,
	"user-set",
	"user-fixed",
];

export const setTimezoneArgv = (tz: string): string[] => ["cmd", "alarm", "set-timezone", tz];
export const TIMEZONE_PROP_ARGV: readonly string[] = ["getprop", "persist.sys.timezone"];
export const setAppLocaleArgv = (pkg: string, tag: string | null): string[] => [
	"cmd",
	"locale",
	"set-app-locales",
	pkg,
	"--locales",
	tag ?? "",
];
export const getAppLocaleArgv = (pkg: string): string[] => ["cmd", "locale", "get-app-locales", pkg];
export const settingGetArgv = (table: "system" | "secure", key: string): string[] => ["settings", "get", table, key];
export const BOLD_TEXT_ADJUSTMENT = 300;
export const trimMemoryArgv = (pkg: string): string[] => ["am", "send-trim-memory", pkg, "RUNNING_CRITICAL"];
export const BATTERY_RESET_ARGV: readonly string[] = ["dumpsys", "battery", "reset"];

export function batteryArgvs(op: { level?: number; charging?: boolean }): string[][] {
	const cmds: string[][] = [];
	if (op.charging === true)
		cmds.push(["dumpsys", "battery", "set", "ac", "1"], ["dumpsys", "battery", "set", "status", "2"]);
	if (op.charging === false) cmds.push(["dumpsys", "battery", "unplug"], ["dumpsys", "battery", "set", "status", "3"]);
	if (op.level !== undefined) cmds.push(["dumpsys", "battery", "set", "level", String(op.level)]);
	return cmds;
}

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

export type AndroidSettings = Pick<
	Driver,
	"permissions" | "timezone" | "locale" | "a11y" | "battery" | "memoryWarning" | "push"
>;

type Shelled = { ok: boolean; stdout: string; failure: string | undefined };

/** What each op needs of the device: a shell that reports, one that must succeed, the app, the API level. */
type Ctx = {
	deps: AndroidSettingsDeps;
	serial: string;
	shell(argv: readonly string[]): Promise<Shelled>;
	must(argv: readonly string[]): DriverResult<string>;
	/** `settings put`, then read back: a font change makes the system write its own value a moment later, so a put is repeated until it holds */
	putSetting(table: "system" | "secure", key: string, value: string): DriverResult<string>;
	packageOf(explicit: string | undefined, what: string): { bundleId: string } | ReturnType<typeof driverErr>;
	sdk(): Promise<number>;
};

const unsupported = (parts: readonly { name: string; reason: string }[]) =>
	driverErr("E_UNSUPPORTED", parts.map((s) => `${s.name}: ${s.reason}`).join("; "));

/** Run one name's manifest permissions; `changed` counts those the app declares. */
async function changePermission(
	c: Ctx,
	bundleId: string,
	manifest: readonly string[],
	state: PermissionState
): DriverResult<number> {
	let changed = 0;
	for (const permission of manifest) {
		const done = await c.shell(permissionArgv(state === "unset" ? "denied" : state, bundleId, permission));
		if (!done.ok) {
			if (NOT_DECLARED.test(done.stdout)) continue;
			return driverErr("E_IO", done.failure ?? permission, { detail: { serial: c.serial } });
		}
		if (state === "unset") await c.shell(clearPermissionFlagsArgv(bundleId, permission));
		changed++;
	}
	return { success: true, data: changed };
}

/** One permission name: undefined when applied, else why it was skipped. */
async function changeNamed(
	c: Ctx,
	bundleId: string,
	name: PermissionName,
	state: PermissionState
): DriverResult<string | undefined> {
	const manifest = ANDROID_PERMISSIONS[name];
	if (manifest === undefined) return { success: true, data: ANDROID_NO_PERMISSION[name] ?? "no Android permission" };
	const changed = await changePermission(c, bundleId, manifest, state);
	if (!changed.success) return changed;
	return {
		success: true,
		data: changed.data === 0 ? `${bundleId} does not declare ${manifest.join(" or ")}` : undefined,
	};
}

function permissionsOp(c: Ctx): Driver["permissions"] {
	return async (grants, opts) => {
		const app = c.packageOf(opts?.bundleId, "permissions");
		if ("success" in app) return app;
		const { bundleId } = app;
		const applied: { permission: PermissionName; state: PermissionState }[] = [];
		const skipped: { permission: PermissionName; reason: string }[] = [];
		for (const [name, state] of Object.entries(grants) as [PermissionName, PermissionState][]) {
			const done = await changeNamed(c, bundleId, name, state);
			if (!done.success) return done;
			if (done.data === undefined) applied.push({ permission: name, state });
			else skipped.push({ permission: name, reason: done.data });
		}
		if (applied.length === 0 && skipped.length > 0) {
			return unsupported(skipped.map((s) => ({ name: s.permission, reason: s.reason })));
		}
		return { success: true, data: { bundleId, applied, skipped } };
	};
}

function timezoneOp(c: Ctx): Driver["timezone"] {
	return async (tz, opts) => {
		if (!c.serial.startsWith("emulator-")) {
			return driverErr("E_UNSUPPORTED", `timezone changes need an emulator; ${c.serial} is not one`);
		}
		const bad = tz === null ? undefined : badRequest(timezoneProblem(tz));
		if (bad) return bad;
		const before = (await c.shell(TIMEZONE_PROP_ARGV)).stdout.trim();
		const target = tz ?? opts?.previous ?? c.deps.hostTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const set = await c.must(setTimezoneArgv(target));
		if (!set.success) return set;
		const after = (await c.shell(TIMEZONE_PROP_ARGV)).stdout.trim();
		if (after !== target) {
			return driverErr("E_IO", `the device timezone is "${after}" after setting "${target}"`, {
				detail: { serial: c.serial },
			});
		}
		return {
			success: true,
			data: { ...(tz === null ? {} : { timezone: tz }), ...(before === "" ? {} : { previous: before }) },
		};
	};
}

function localeOp(c: Ctx): Driver["locale"] {
	return async (tag, opts) => {
		const app = c.packageOf(opts?.bundleId, "locale");
		if ("success" in app) return app;
		const { bundleId } = app;
		const bad = tag === null ? undefined : badRequest(localeProblem(tag));
		if (bad) return bad;
		const level = await c.sdk();
		if (level < APP_LOCALES_MIN_SDK) {
			return driverErr(
				"E_UNSUPPORTED",
				`per-app locales need Android 13 (API ${APP_LOCALES_MIN_SDK}); this device is API ${level}`
			);
		}
		const set = await c.must(setAppLocaleArgv(bundleId, tag));
		if (!set.success) return set;
		const read = await c.shell(getAppLocaleArgv(bundleId));
		if (tag !== null && !read.stdout.includes(`[${tag}`)) {
			return driverErr("E_IO", `${bundleId} reports ${read.stdout.trim()} after setting ${tag}`, {
				detail: { serial: c.serial },
			});
		}
		return { success: true, data: { ...(tag === null ? {} : { locale: tag }), bundleId } };
	};
}

/** The font scale an a11y text size means on Android, with a note when it was clamped. */
function fontScaleOf(size: TextSize | undefined): { scale: number; notes: string[] } | ReturnType<typeof driverErr> {
	if (size === undefined) return { scale: 1, notes: [] };
	const resolved = resolveTextSize(size);
	if (!resolved.success) return driverErr("E_BAD_REQUEST", resolved.error);
	const scale = androidFontScale(resolved.data.scale);
	return {
		scale,
		notes:
			scale === resolved.data.scale ? [] : [`font scale ${resolved.data.scale} clamped to ${scale} (Android's range)`],
	};
}

/** Settings with no shell mechanism on Android, for the ones `op` asks for. */
function a11ySkips(op: A11yOp | null): { setting: string; reason: string }[] {
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

function a11yOp(c: Ctx): Driver["a11y"] {
	return async (op) => {
		const applied: string[] = [];
		const skipped: { setting: string; reason: string }[] = [];
		let notes: string[] = [];
		if (op === null || op.textSize !== undefined) {
			const font = fontScaleOf(op?.textSize);
			if ("success" in font) return font;
			notes = font.notes;
			const done = await c.putSetting("system", "font_scale", String(font.scale));
			if (!done.success) return done;
			applied.push("textSize");
		}
		if (op === null || op.boldText !== undefined) {
			const done = await c.putSetting(
				"secure",
				"font_weight_adjustment",
				String(op?.boldText === true ? BOLD_TEXT_ADJUSTMENT : 0)
			);
			if (!done.success) return done;
			applied.push("boldText");
		}
		skipped.push(...a11ySkips(op));
		if (applied.length === 0 && skipped.length > 0) {
			return unsupported(skipped.map((s) => ({ name: s.setting, reason: s.reason })));
		}
		return { success: true, data: { applied, skipped, notes } satisfies A11yState };
	};
}

function batteryRequestProblem(op: BatteryOp) {
	const bad = badRequest(batteryProblem(op.level));
	if (bad) return bad;
	return batteryArgvs(op).length === 0
		? driverErr("E_BAD_REQUEST", "battery needs a level, charging, or both")
		: undefined;
}

function batteryOp(c: Ctx): Driver["battery"] {
	return async (op) => {
		if (!c.serial.startsWith("emulator-")) {
			return driverErr("E_UNSUPPORTED", `battery changes need an emulator; ${c.serial} is not one`);
		}
		if (op === null) {
			const done = await c.must(BATTERY_RESET_ARGV);
			return done.success ? { success: true, data: { cosmetic: false } satisfies BatteryState } : done;
		}
		const bad = batteryRequestProblem(op);
		if (bad) return bad;
		for (const cmd of batteryArgvs(op)) {
			const done = await c.must(cmd);
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
}

function memoryWarningOp(c: Ctx): Driver["memoryWarning"] {
	return async (opts) => {
		const app = c.packageOf(opts?.bundleId, "memoryWarning");
		if ("success" in app) return app;
		const sent = await c.shell(trimMemoryArgv(app.bundleId));
		if (sent.ok && !/Exception/.test(sent.stdout)) return { success: true, data: undefined };
		if (/Unknown process/.test(sent.stdout)) {
			return driverErr(
				"E_APP_UNAVAILABLE",
				`${app.bundleId} is not running, so there is no process to send the trim to`
			);
		}
		return driverErr("E_IO", sent.failure ?? sent.stdout.trim(), { detail: { serial: c.serial } });
	};
}

export function createAndroidSettings(deps: AndroidSettingsDeps): AndroidSettings {
	const { session, serial } = deps;

	async function shell(argv: readonly string[]): Promise<Shelled> {
		const res = await session.run(shellCommand(argv));
		if (!res.success) return { ok: false, stdout: "", failure: res.error.message };
		const ok = res.data.exitCode === 0;
		return {
			ok,
			stdout: res.data.stdout,
			failure: ok ? undefined : `${argv.join(" ")}: ${res.data.stdout.trim() || `exit ${res.data.exitCode}`}`,
		};
	}

	async function must(argv: readonly string[]): DriverResult<string> {
		const done = await shell(argv);
		return done.ok
			? { success: true, data: done.stdout }
			: driverErr("E_IO", done.failure ?? argv.join(" "), { detail: { serial } });
	}

	const ctx: Ctx = {
		deps,
		serial,
		shell,
		must,
		async putSetting(table, key, value) {
			const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
			let last = "";
			for (let attempt = 0; attempt < SETTING_ATTEMPTS; attempt++) {
				const put = await must(["settings", "put", table, key, value]);
				if (!put.success) return put;
				await sleep(SETTING_SETTLE_MS);
				last = (await shell(settingGetArgv(table, key))).stdout.trim();
				// an empty read (a shell that does not answer `get`) cannot contradict the write
				if (last === "" || Number(last) === Number(value)) return put;
			}
			return driverErr("E_IO", `${table} ${key} reads ${last} after setting ${value}`, { detail: { serial } });
		},
		packageOf(explicit, what) {
			const bundleId = explicit ?? deps.appPackage;
			return bundleId === undefined
				? driverErr("E_BAD_REQUEST", `${what} needs an app: pass a package name`)
				: { bundleId };
		},
		async sdk() {
			const out = await shell(["getprop", "ro.build.version.sdk"]);
			return Number(out.stdout.trim()) || 0;
		},
	};

	return {
		permissions: permissionsOp(ctx),
		timezone: timezoneOp(ctx),
		locale: localeOp(ctx),
		a11y: a11yOp(ctx),
		battery: batteryOp(ctx),
		memoryWarning: memoryWarningOp(ctx),
		async push() {
			return driverErr(
				"E_UNSUPPORTED",
				"push notifications through the shell are iOS only (`simctl push`); Android needs FCM"
			);
		},
	};
}
