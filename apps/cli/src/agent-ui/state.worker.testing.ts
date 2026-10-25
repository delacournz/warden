import { join } from "node:path";
import { openStore } from "@delacour/warden-core/store";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { commitGeneration, type UiState, updateState, writeLastSnapshot } from "./state";

/**
 * A second `warden ui` process for the state tests. `bun state.worker.testing.ts <home> <udid> <count>` takes `count`
 * generations through its own store connection, storing a snapshot each time, and prints them as JSON.
 * `… <count> <field>` instead sets one `state.json` record (`helper` | `video` | `collector`) `count`
 * times through `updateState`, the n-th time with pid / startedAt `n`, and prints `count`.
 */
const [home = "", udid = "", count = "0", field] = process.argv.slice(2);
const store = openStore(join(home, "warden.db"));
const ctx = { env: { WARDEN_HOME: home }, now: () => Date.now(), store: () => store };

function withField(state: UiState, name: string, n: number): UiState {
	switch (name) {
		case "helper":
			return { ...state, helper: { pid: n, socket: "/s" } };
		case "video":
			return { ...state, video: { pid: n, path: "/v.mp4", startedAt: n } };
		case "collector":
			return { ...state, collector: { pid: n, startedAt: n } };
		default:
			throw new Error(`unknown field ${name}`);
	}
}

if (field !== undefined) {
	for (let n = 1; n <= Number(count); n += 1) updateState(ctx, udid, (state) => withField(state, field, n));
	store.close();
	console.log(count);
} else {
	const snapshot = snapshotOf([el("button", { label: "Go", id: "go" })]);
	const taken: number[] = [];
	for (let n = 0; n < Number(count); n += 1) {
		taken.push(
			commitGeneration(ctx, udid, (generation) => {
				writeLastSnapshot(ctx, udid, { generation, takenAt: Date.now(), hash: String(generation), snapshot });
				return generation;
			})
		);
	}
	store.close();
	console.log(JSON.stringify(taken));
}
