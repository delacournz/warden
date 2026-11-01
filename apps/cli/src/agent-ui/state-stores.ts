import type { RefStore } from "@delacour/warden-sdk/ops/ref-store";
import type { DeviceState, StateStore } from "@delacour/warden-sdk/ops/state-store";
import type { CommandContext } from "../context";
import { type UiState, uiStatePersistence } from "./state";

type StoreContext = Pick<CommandContext, "env" | "now" | "store">;

export class UiStateStores {
	/**
	 * The CLI's {@link RefStore}: `last-snapshot.json` plus the generation counter in the warden store, both under
	 * `$WARDEN_HOME/ui/<udid>`. A commit takes the next generation and writes the snapshot inside the store's
	 * `BEGIN IMMEDIATE` transaction (the cross-process mutex), so `@eN` refs keep working across `warden ui` processes
	 * and an older process can never leave a lower generation behind.
	 */
	createFileRefStore(ctx: StoreContext, udid: string): RefStore {
		return {
			last: () => uiStatePersistence.readLastSnapshot(ctx, udid),
			commit: (entry) =>
				uiStatePersistence.commitGeneration(ctx, udid, (generation) => {
					const stored = { ...entry, generation };
					uiStatePersistence.writeLastSnapshot(ctx, udid, stored);
					return stored;
				}),
		};
	}

	/** The ops' slice of `state.json`; keys the file does not hold are left out. */
	private deviceStateOf(state: UiState): DeviceState {
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
	createFileStateStore(ctx: StoreContext, udid: string): StateStore {
		return {
			read: () => this.deviceStateOf(uiStatePersistence.readState(ctx, udid)),
			update: (change) =>
				this.deviceStateOf(
					uiStatePersistence.updateState(ctx, udid, (current) => {
						const before = this.deviceStateOf(current);
						const after = change(before);
						if (after === before) return current;
						const { metroUrl: _m, app: _a, collector: _c, video: _v, recording: _r, ...kept } = current;
						return { ...kept, ...after };
					})
				),
		};
	}
}

export const uiStateStores = new UiStateStores();
