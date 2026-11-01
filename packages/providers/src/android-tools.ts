import { join } from "node:path";

/** Leaf: where `adb` / `emulator` live. Builds and the e2e drivers import this, not `providers/android`. */
export type AndroidTools = { adb: string; emulator: string };

/** Finds the Android SDK binaries. */
export class AndroidToolsLocator {
	/** `adb`/`emulator` from `$ANDROID_HOME` / `$ANDROID_SDK_ROOT`, else bare PATH names. */
	locate(env: Record<string, string | undefined>): AndroidTools {
		const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
		if (!sdk) return { adb: "adb", emulator: "emulator" };
		return { adb: join(sdk, "platform-tools", "adb"), emulator: join(sdk, "emulator", "emulator") };
	}
}

export const androidToolsLocator = new AndroidToolsLocator();
