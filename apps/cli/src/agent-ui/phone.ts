import { installedBundleIds } from "@delacour/warden-core/builds/cache";
import { classifyOther, isEmulatorSerial, listAdbDevices } from "@delacour/warden-core/providers/android";
import type { DeviceResource } from "@delacour/warden-core/types";
import type { CommandContext } from "../context";
import { type UiError, uiError } from "./output";

/** What an Android serial `warden ui` was given turned out to be. */
export type PhoneCheck =
	| { kind: "other" }
	| { kind: "phone"; adbState: string; physical: NonNullable<DeviceResource["physical"]> };

/**
 * Is `serial` a real phone? A console `emulator-N` never is (no adb call). Anything else is looked up in
 * `adb devices -l`; a `device`-state row is read for qemu props (a network emulator is `other`). An adb that
 * cannot be run, or a serial adb does not list, is `other`: the driver then fails with its own error.
 */
export async function checkPhone(ctx: Pick<CommandContext, "exec" | "env">, serial: string): Promise<PhoneCheck> {
	if (isEmulatorSerial(serial)) return { kind: "other" };
	const listed = await listAdbDevices(ctx);
	if (!listed.success) return { kind: "other" };
	const row = listed.data.find((e) => e.serial === serial);
	if (row?.kind !== "other") return { kind: "other" };
	let hwSerial: string | undefined;
	if (row.state === "device") {
		const classified = await classifyOther(ctx, serial);
		if (classified.success && classified.data.emulator) return { kind: "other" };
		hwSerial = classified.success ? classified.data.hwSerial : undefined;
	}
	return {
		kind: "phone",
		adbState: row.state,
		physical: { transport: row.transport, ...(hwSerial !== undefined ? { hwSerial } : {}) },
	};
}

/** The exit-2 error for a phone adb lists but cannot drive yet, or undefined when it is ready. */
export function phoneStateError(serial: string, adbState: string): UiError | undefined {
	if (adbState === "device") return undefined;
	if (adbState === "unauthorized" || adbState === "authorizing") {
		return uiError("device_unauthorized", `${serial} is unauthorized: USB debugging is not allowed for this computer`, {
			hint: "unlock the phone and accept the USB debugging prompt (tick Always allow), then retry",
			details: { serial, adbState },
		});
	}
	return uiError("device_offline", `${serial} is ${adbState} in adb`, {
		hint: "reconnect the cable (or adb connect / re-pair wireless debugging) and unlock the phone, then retry",
		details: { serial, adbState },
	});
}

/**
 * The packages warden may uninstall or wipe on a phone: `WARDEN_BUNDLE_ID` and everything the `installs` table
 * records for that serial. Anything else on a physical device is the owner's.
 */
export function ownedPackages(ctx: Pick<CommandContext, "env" | "store">, serial: string): string[] {
	const owned = new Set(installedBundleIds(ctx.store(), "android", serial));
	const bundleId = ctx.env.WARDEN_BUNDLE_ID?.trim();
	if (bundleId) owned.add(bundleId);
	return [...owned];
}
