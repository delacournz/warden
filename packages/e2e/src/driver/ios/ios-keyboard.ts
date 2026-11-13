import { DEFAULT_KEYBOARD_MODE, type KeyboardMode } from "@delacour/warden-core/conditions/conditions.types";
import type { Result } from "@delacour/warden-types/result";
import type { Driver, DriverError, DriverResult } from "../driver.types";
import { driverErr, driverError } from "../errors";
import { type InjectChannel, injectLaunchEnv } from "./inject";
import { INJECT_ACK_MS, INJECT_LOAD_MS } from "./ios-network";

/**
 * The on-screen keyboard of an iOS simulator app (KBD-2). HID typing makes iOS treat a hardware keyboard as attached
 * and minimise the software keyboard; the injected dylib answers `-[UIKeyboardImpl isMinimized]` with NO while the mode
 * is `software`, and re-lays the input views on every change. The mode lives in the state file's `keyboard` field (the
 * lease's, so it survives an app relaunch) and in `WARDEN_KEYBOARD` at launch.
 */
export type IosKeyboardDeps = {
	channel: InjectChannel;
	/** where `libwarden-inject.dylib` is */
	dylib: () => Result<string, DriverError>;
	debug?: boolean;
};

export type IosKeyboard = {
	/** the mode in force: the state file's, else the default */
	mode(): KeyboardMode;
	/**
	 * Env that loads the dylib with the keyboard mode, for a launch no other layer already injects (`undefined`: those
	 * layers carry the dylib; `WARDEN_KEYBOARD` goes through `launchMode`). A dylib that cannot be found is no launch
	 * failure: the app runs plain, with the keyboard as iOS decides.
	 */
	launchEnv(): Record<string, string> | undefined;
	/** `WARDEN_KEYBOARD` to merge into the env of a launch that carries the dylib already */
	launchMode(): Record<string, string>;
	/** after a launch that carried the dylib on its own: wait until it loaded */
	confirmLoaded(): DriverResult<void>;
	keyboard: Driver["keyboard"];
	/**
	 * Resign the first responder in the app (the dylib, on the main thread), acknowledged through the channel.
	 * `attached: false`: no app with the dylib is running, nothing was written and the caller falls back.
	 */
	dismiss(): DriverResult<{ attached: boolean }>;
};

const okVoid = { success: true as const, data: undefined };

export function createIosKeyboard(deps: IosKeyboardDeps): IosKeyboard {
	const { channel } = deps;
	let expectLoad = false;
	const mode = (): KeyboardMode => channel.current().keyboard ?? DEFAULT_KEYBOARD_MODE;
	return {
		mode,
		launchEnv() {
			const dylib = deps.dylib();
			if (!dylib.success) return undefined;
			channel.reset();
			channel.write({});
			expectLoad = true;
			return injectLaunchEnv({
				dylib: dylib.data,
				statePath: channel.statePath,
				keyboard: mode(),
				...(deps.debug ? { debug: true } : {}),
			});
		},
		launchMode: () => ({ WARDEN_KEYBOARD: mode() }),
		async confirmLoaded() {
			if (!expectLoad) return okVoid;
			expectLoad = false;
			if (await channel.acked(channel.current().seq, INJECT_LOAD_MS)) return okVoid;
			const error: DriverError = driverError(
				"E_INTERNAL",
				`the app did not load libwarden-inject.dylib within ${INJECT_LOAD_MS} ms: the keyboard mode would not reach it. Check the app is a simulator build, and run with WARDEN_E2E_DEBUG=1`,
				{ detail: { statePath: channel.statePath } }
			);
			return { success: false, error };
		},
		async dismiss() {
			if (!channel.attached()) return { success: true, data: { attached: false } };
			const { seq: _seq, a11yRead: _read, ...rest } = channel.current();
			const state = channel.write({ ...rest, dismissKeyboard: true });
			if (await channel.acked(state.seq, INJECT_ACK_MS)) return { success: true, data: { attached: true } };
			return driverErr("E_TIMEOUT", `the app did not acknowledge the keyboard dismissal within ${INJECT_ACK_MS} ms`, {
				detail: { statePath: channel.statePath },
			});
		},
		async keyboard(next) {
			const { seq: _seq, a11yRead: _read, ...rest } = channel.current();
			const state = channel.write({ ...rest, keyboard: next });
			if (!channel.attached()) return { success: true, data: { mode: next, appliesOnLaunch: true } };
			if (await channel.acked(state.seq, INJECT_ACK_MS)) return { success: true, data: { mode: next } };
			return driverErr("E_TIMEOUT", `the app did not acknowledge the keyboard mode within ${INJECT_ACK_MS} ms`, {
				detail: { statePath: channel.statePath },
			});
		},
	};
}
