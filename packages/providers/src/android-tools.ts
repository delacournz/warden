import { join } from "node:path";

/** Leaf: where `adb` / `emulator` live. Builds and the e2e drivers import this, not `providers/android`. */
export type AndroidTools = { adb: string; emulator: string };

/** `adb`/`emulator` from `$ANDROID_HOME` / `$ANDROID_SDK_ROOT`, else bare PATH names. */
export function androidTools(env: Record<string, string | undefined>): AndroidTools {
	const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
	if (!sdk) return { adb: "adb", emulator: "emulator" };
	return { adb: join(sdk, "platform-tools", "adb"), emulator: join(sdk, "emulator", "emulator") };
}
