import { clearCondition, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { CameraCondition } from "@delacour/warden-core/conditions/conditions.types";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { createAndroidProvider } from "@delacour/warden-core/providers/android";
import type { DeviceProvider } from "@delacour/warden-core/providers/provider.types";
import type { Store } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { sharedStoreOpener } from "../../conditions/lease-store";
import type { AndroidCameraDeps } from "./android-camera";

/** How long a restarted camera emulator gets to finish booting (a cold boot is ~16 s). */
const RELAUNCH_READY_MS = 180_000;

export type AndroidCameraHostOptions = {
	serial: string;
	env?: Record<string, string | undefined>;
	exec?: Exec;
	now?: () => number;
	/** the lease store (default: the process's shared connection) */
	store?: () => Result<Store>;
	/** the Android provider (default: a real one on `adb` / `emulator`) */
	provider?: (store: Store) => DeviceProvider;
};

/** What `createAndroidCamera` needs from warden's state: the device's recorded profile, a restart, the lease record. */
export type AndroidCameraHost = Pick<AndroidCameraDeps, "profile" | "relaunch"> &
	Required<Pick<AndroidCameraDeps, "record">>;

/** A restart takes no new leases, so the provider's owner is only a label. */
const processOwner = (): Owner => ({ kind: "user", pid: process.pid, cwd: process.cwd() });

/**
 * The camera driver's view of warden's store and provider, opened lazily: a run that never touches the camera never
 * opens either. The profile (`<avd>+cam`) is what the claim recorded for the serial; a restart goes through the same
 * provider that launched the emulator, so the serial, console port, device record and lease stay.
 */
export function createAndroidCameraHost(options: AndroidCameraHostOptions): AndroidCameraHost {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const openStore = options.store ?? sharedStoreOpener(env);

	const withStore = <T>(use: (store: Store) => T, fallback: T): T => {
		const opened = openStore();
		return opened.success ? use(opened.data) : fallback;
	};

	return {
		profile: () =>
			withStore((store) => store.listDevices("android").find((d) => d.id === options.serial)?.profile, undefined),

		relaunch: async () => {
			const opened = openStore();
			if (!opened.success) return err(opened.error);
			const provider =
				options.provider?.(opened.data) ??
				createAndroidProvider({
					exec: options.exec ?? bunExec,
					store: opened.data,
					env,
					now,
					owner: processOwner(),
				});
			if (provider.relaunch === undefined) return err("this provider cannot restart a device");
			const relaunched = await provider.relaunch(options.serial);
			if (!relaunched.success) return relaunched;
			const ready = await provider.waitReady(options.serial, RELAUNCH_READY_MS);
			return ready.success ? ok(undefined) : ready;
		},

		record: (feeds: CameraCondition) => {
			withStore((store) => {
				const lease = store.listLeases().find((l) => l.resource.kind === "device" && l.resource.id === options.serial);
				if (lease === undefined) return;
				if (Object.keys(feeds).length === 0) clearCondition(store, lease.id, "camera");
				else recordCondition(store, lease.id, "camera", feeds, now());
			}, undefined);
		},
	};
}
