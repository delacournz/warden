import type { RecordingPointer } from "./authoring/pointer";

/** A resident helper process the CLI keeps between calls (pid, socket, the binary it was started from, its owner). */
export type HelperRecord = {
	pid: number;
	socket: string;
	owner?: string;
	binary?: { path: string; mtimeMs: number };
	env?: string;
	lease?: string;
};

/**
 * What the ops remember about one device between calls (the ops' view of `state.json`): the app `open` launched, the
 * Metro it was pointed at, and the background helpers (screen recorder, log collector).
 */
export type DeviceState = {
	metroUrl?: string;
	/** bundle id of the app `open` last launched (`close --app` terminates it) */
	app?: string;
	/** the device's resident `warden __android-host` (Android): pid, socket and the binary it runs, like the iOS `warden-simd` */
	androidHost?: HelperRecord;
	/** the physical iPhone's resident `warden __ios-runner-host`: same record as `androidHost` */
	iosRunner?: HelperRecord;
	/** the running `logs start` collector: host pid, start time and its `--out` dir */
	collector?: { pid: number; startedAt: number; out?: string };
	/** the running `video start` recorder: host pid, output file, and (Android) the file on the device */
	video?: { pid: number; path: string; remote?: string; startedAt: number };
	/** the spec recording in progress (`record start`); its steps are in the journal */
	recording?: RecordingPointer;
};

/**
 * Read-modify-write access to a device's {@link DeviceState}. `update` must not block and must return the full next
 * state (a key left out is removed); returning the state it was given writes nothing. The CLI's file-backed store runs
 * `update` under the warden store's `BEGIN IMMEDIATE` transaction, so two processes never lose each other's records.
 */
export type StateStore = {
	read: () => DeviceState;
	update: (change: (state: DeviceState) => DeviceState) => DeviceState;
};

export class StateStores {
	/** In-process {@link StateStore}. */
	createMemoryStateStore(initial: DeviceState = {}): StateStore {
		let state: DeviceState = initial;
		return {
			read: () => state,
			update: (change) => {
				state = change(state);
				return state;
			},
		};
	}
}

export const stateStores = new StateStores();
