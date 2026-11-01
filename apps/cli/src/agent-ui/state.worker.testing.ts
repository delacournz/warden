import { join } from "node:path";
import { driverFixtures } from "@delacour/warden-driver/testing/driver";
import { storeLocator } from "@delacour/warden-store/store";
import { type UiState, uiStatePersistence } from "./state";

/**
 * A second `warden ui` process for the state tests. `bun state.worker.testing.ts <home> <udid> <count>` takes `count`
 * generations through its own store connection, storing a snapshot each time, and prints them as JSON.
 * `… <count> <field>` instead sets one `state.json` record (`helper` | `video` | `collector` | `recording`) `count`
 * times through `updateState`, the n-th time with pid / startedAt `n`, and prints `count`.
 */
const [home = "", udid = "", count = "0", field] = process.argv.slice(2);
const store = storeLocator.open(join(home, "warden.db"));
const ctx = { env: { WARDEN_HOME: home }, now: () => Date.now(), store: () => store };

class StateWorkerFields {
	withField(state: UiState, name: string, n: number): UiState {
		switch (name) {
			case "helper":
				return { ...state, helper: { pid: n, socket: "/s" } };
			case "video":
				return { ...state, video: { pid: n, path: "/v.mp4", startedAt: n } };
			case "collector":
				return { ...state, collector: { pid: n, startedAt: n } };
			case "recording":
				return { ...state, recording: { name: "f", target: { kind: "spec", path: "/f.e2e.ts" }, startedAt: n } };
			default:
				throw new Error(`unknown field ${name}`);
		}
	}
}

const stateWorkerFields = new StateWorkerFields();

if (field !== undefined) {
	for (let n = 1; n <= Number(count); n += 1)
		uiStatePersistence.updateState(ctx, udid, (state) => stateWorkerFields.withField(state, field, n));
	store.close();
	console.log(count);
} else {
	const snapshot = driverFixtures.snapshotOf([driverFixtures.el("button", { label: "Go", id: "go" })]);
	const taken: number[] = [];
	for (let n = 0; n < Number(count); n += 1) {
		taken.push(
			uiStatePersistence.commitGeneration(ctx, udid, (generation) => {
				uiStatePersistence.writeLastSnapshot(ctx, udid, {
					generation,
					takenAt: Date.now(),
					hash: String(generation),
					snapshot,
				});
				return generation;
			})
		);
	}
	store.close();
	console.log(JSON.stringify(taken));
}
