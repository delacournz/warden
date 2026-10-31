import { ANDROID_A11Y_ENABLED_KEY, ANDROID_SERVICES_KEY } from "@delacour/warden-core/conditions/a11y-keys";
import type { ScreenReaderState } from "../../a11y/a11y.types";
import type { DriverResult } from "../driver.types";
import { driverErr } from "../errors";

/**
 * TalkBack as the screen reader of an Android emulator (WDN-A11Y, A11Y-7). Everything is shell: the two secure settings
 * that switch an accessibility service on, `pm` for presence and the notification grant, `dumpsys accessibility` to
 * see that the service is bound (enabled in settings is not running: a UiAutomation client connected without
 * `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` unbinds it). The previous values of both settings are kept so turning
 * TalkBack off, or the lease's undo, puts back exactly what was there.
 */

export const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
export const TALKBACK_SERVICE = `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.TalkBackService`;
export const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

export const talkbackPathArgv: readonly string[] = ["pm", "path", TALKBACK_PACKAGE];
export const talkbackGrantArgv: readonly string[] = ["pm", "grant", TALKBACK_PACKAGE, POST_NOTIFICATIONS];
export const accessibilityDumpArgv: readonly string[] = ["dumpsys", "accessibility"];
export const secureGetArgv = (key: string): string[] => ["settings", "get", "secure", key];
/** Set a secure key, or delete it when `value` is null (it was unset). The driver's shell quotes each argument. */
export const secureWriteArgv = (key: string, value: string | null): string[] =>
	value === null ? ["settings", "delete", "secure", key] : ["settings", "put", "secure", key, value];

/** `settings get` answers the text `null` for an unset key. */
export function settingValue(stdout: string): string | null {
	const value = stdout.trim();
	return value === "" || value === "null" ? null : value;
}

/** `services` with the TalkBack component added after whatever is there (`:` separated, once). */
export function withTalkBack(services: string | null): string {
	if (services === null) return TALKBACK_SERVICE;
	const parts = services.split(":").filter((part) => part !== "");
	return parts.includes(TALKBACK_SERVICE) ? services : [...parts, TALKBACK_SERVICE].join(":");
}

/** Is a TalkBack service among the bound ones in `dumpsys accessibility`? */
export function talkbackBound(dump: string): boolean {
	const line = /Bound services:\{(.*)/.exec(dump)?.[1] ?? "";
	return /TalkBack|marvin\.talkback/i.test(line);
}

export type Previous = { services: string | null; enabled: string | null };

type Shelled = { ok: boolean; stdout: string; failure: string | undefined };

export type TalkBackDeps = {
	serial: string;
	shell(argv: readonly string[]): Promise<Shelled>;
	must(argv: readonly string[]): DriverResult<string>;
	/** is `warden-uiad` the way this driver reads the screen (the dump unbinds TalkBack) */
	uiadAvailable(): boolean;
	sleep(ms: number): Promise<void>;
};

export type TalkBackControl = {
	/** warden turned TalkBack on and has not turned it off */
	active(): boolean;
	/** TalkBack is the screen reader now: warden's doing, or found already on and bound by `detect` */
	on(): boolean;
	/** read the device once (`fresh`: again, for a TalkBack another process turned on since) for a TalkBack that was on before warden touched anything (a crashed run, a person) */
	detect(fresh?: boolean): Promise<boolean>;
	state(): ScreenReaderState;
	previous(): Previous | undefined;
	enable(): DriverResult<ScreenReaderState>;
	disable(): DriverResult<ScreenReaderState>;
	/** is the service bound right now */
	bound(): Promise<boolean>;
};

const BIND_POLL_MS = 250;
const BIND_ATTEMPTS = 24;

export function createTalkBack(deps: TalkBackDeps): TalkBackControl {
	let previous: Previous | undefined;
	let external = false;
	let detected = false;

	async function bound(): Promise<boolean> {
		const dump = await deps.shell(accessibilityDumpArgv);
		return dump.ok && talkbackBound(dump.stdout);
	}

	async function waitBound(want: boolean): Promise<boolean> {
		for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
			if ((await bound()) === want) return true;
			await deps.sleep(BIND_POLL_MS);
		}
		return false;
	}

	async function put(prior: Previous): DriverResult<void> {
		for (const argv of [
			secureWriteArgv(ANDROID_SERVICES_KEY, prior.services),
			secureWriteArgv(ANDROID_A11Y_ENABLED_KEY, prior.enabled),
		]) {
			const done = await deps.must(argv);
			if (!done.success) return done;
		}
		return { success: true, data: undefined };
	}

	return {
		active: () => previous !== undefined,
		on: () => previous !== undefined || external,
		async detect(fresh = false) {
			if ((detected && !fresh) || previous !== undefined) return previous !== undefined || external;
			detected = true;
			const [services, enabled] = await Promise.all([
				deps.shell(secureGetArgv(ANDROID_SERVICES_KEY)),
				deps.shell(secureGetArgv(ANDROID_A11Y_ENABLED_KEY)),
			]);
			const listed = (settingValue(services.stdout) ?? "").split(":").includes(TALKBACK_SERVICE);
			external = listed && settingValue(enabled.stdout) === "1" && (await bound());
			return external;
		},
		state: () => (previous === undefined && !external ? { mode: "off" } : { mode: "real", engine: "talkback" }),
		previous: () => previous,

		async enable() {
			if (previous !== undefined) return { success: true, data: { mode: "real", engine: "talkback" } };
			const present = await deps.shell(talkbackPathArgv);
			if (!present.ok || !present.stdout.includes("package:")) {
				return driverErr(
					"E_UNSUPPORTED",
					`TalkBack (${TALKBACK_PACKAGE}) is not installed on ${deps.serial}: use an emulator with a Google Play system image`
				);
			}
			if (!deps.uiadAvailable()) {
				return driverErr(
					"E_UNSUPPORTED",
					"TalkBack mode needs the warden-uiad server: the uiautomator dump fallback unbinds TalkBack on every read"
				);
			}
			// without the grant the first run shows a permission dialog over the app
			await deps.shell(talkbackGrantArgv);
			const [services, enabled] = await Promise.all([
				deps.shell(secureGetArgv(ANDROID_SERVICES_KEY)),
				deps.shell(secureGetArgv(ANDROID_A11Y_ENABLED_KEY)),
			]);
			const prior: Previous = { services: settingValue(services.stdout), enabled: settingValue(enabled.stdout) };
			const written = await put({ services: withTalkBack(prior.services), enabled: "1" });
			if (!written.success) {
				await put(prior);
				return written;
			}
			previous = prior;
			if (!(await waitBound(true))) {
				previous = undefined;
				await put(prior);
				return driverErr(
					"E_IO",
					`TalkBack did not bind within ${(BIND_ATTEMPTS * BIND_POLL_MS) / 1000}s on ${deps.serial} (is the device unlocked?)`
				);
			}
			return { success: true, data: { mode: "real", engine: "talkback" } };
		},

		async disable() {
			if (previous === undefined) return { success: true, data: { mode: "off" } };
			const prior = previous;
			const restored = await put(prior);
			if (!restored.success) return restored;
			previous = undefined;
			// the service lets go a moment after its setting does; not waiting would leave the next read racing it
			await waitBound(false);
			return { success: true, data: { mode: "off" } };
		},

		bound,
	};
}
