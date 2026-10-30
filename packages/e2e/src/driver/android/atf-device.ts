import type { DriverResult, Logger } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { ATF_DEX } from "./atf-dex.generated";
import { bunPushDex, type PushDex, UIAD_DEVICE_DIR, uiadInstallArgv, uiadPresentCommand } from "./uiad-device";

/**
 * `warden-atf.jar` (the Accessibility Test Framework, ~180 KB) goes to the device on the first audit only, named by its
 * hash like the uiad dex, so a new build is a new file and the always-pushed uiad dex stays small.
 */

export type AtfJar = Pick<typeof ATF_DEX, "bytes" | "jarSha256" | "base64">;

export function atfDevicePath(jar: Pick<AtfJar, "jarSha256"> = ATF_DEX): string {
	return `${UIAD_DEVICE_DIR}/warden-atf-${jar.jarSha256.slice(0, 8)}.jar`;
}

export type EnsureAtfDeps = {
	session: AdbSession;
	adb: string;
	serial: string;
	push?: PushDex;
	jar?: AtfJar;
	log?: Logger;
};

/** The jar is on the device (written now if it was not); the result is its path. */
export async function ensureAtfJar(deps: EnsureAtfDeps): DriverResult<string> {
	const jar = deps.jar ?? ATF_DEX;
	const path = atfDevicePath(jar);
	const present = await deps.session.run(uiadPresentCommand(path, jar.bytes));
	if (present.success && present.data.stdout.includes("present")) return { success: true, data: path };
	const wrote = await (deps.push ?? bunPushDex)(
		uiadInstallArgv(deps.adb, deps.serial, path),
		Buffer.from(jar.base64, "base64")
	);
	if (wrote.exitCode !== 0) {
		return driverErr("E_IO", `cannot write warden-atf to ${deps.serial}:${path}: ${wrote.output.slice(0, 200)}`);
	}
	deps.log?.(`atf: wrote ${jar.bytes} B to ${path}`);
	return { success: true, data: path };
}
