import type { RefStore } from "@delacour/warden-sdk/ops/ref-store";
import type { DeviceState, StateStore } from "@delacour/warden-sdk/ops/state-store";
import type { CommandContext } from "../context";
import { commitGeneration, readLastSnapshot, readState, type UiState, updateState, writeLastSnapshot } from "./state";

type StoreContext = Pick<CommandContext, "env" | "now" | "store">;

/**
 * The CLI's {@link RefStore}: `last-snapshot.json` plus the generation counter in the warden store, both under
 * `$WARDEN_HOME/ui/<udid>`. A commit takes the next generation and writes the snapshot inside the store's
 * `BEGIN IMMEDIATE` transaction (the cross-process mutex), so `@eN` refs keep working across `warden ui` processes
 * and an older process can never leave a lower generation behind.
 */
export function createFileRefStore(ctx: StoreContext, udid: string): RefStore {
	return {
		last: () => readLastSnapshot(ctx, udid),
		commit: (entry) =>
			commitGeneration(ctx, udid, (generation) => {
				const stored = { ...entry, generation };
				writeLastSnapshot(ctx, udid, stored);
				return stored;
			}),
	};
}

/** The ops' slice of `state.json`; keys the file does not hold are left out. */
function deviceStateOf(state: UiState): DeviceState {
	return {
		...(state.metroUrl !== undefined ? { metroUrl: state.metroUrl } : {}),
		...(state.app !== undefined ? { app: state.app } : {}),
		...(state.collector !== undefined ? { collector: state.collector } : {}),
		...(state.video !== undefined ? { video: state.video } : {}),
		...(state.recording !== undefined ? { recording: state.recording } : {}),
	};
}

/**
 * The CLI's {@link StateStore}: the device's `state.json`, updated under the warden store's transaction. Fields the
 * ops do not own (the generation, the resident helper's record) pass through untouched.
 */
export function createFileStateStore(ctx: StoreContext, udid: string): StateStore {
	return {
		read: () => deviceStateOf(readState(ctx, udid)),
		update: (change) =>
			deviceStateOf(
				updateState(ctx, udid, (current) => {
					const before = deviceStateOf(current);
					const after = change(before);
					if (after === before) return current;
					const { metroUrl: _m, app: _a, collector: _c, video: _v, recording: _r, ...kept } = current;
					return { ...kept, ...after };
				})
			),
	};
}
