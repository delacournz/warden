import { join } from "node:path";
import { openStore } from "@delacour/warden-core/store";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { commitGeneration, writeLastSnapshot } from "./state";

/**
 * A second `warden ui` process for the generation tests: `bun state.worker.testing.ts <home> <udid> <count>` takes
 * `count` generations through its own store connection, storing a snapshot each time, and prints them as JSON.
 */
const [home = "", udid = "", count = "0"] = process.argv.slice(2);
const store = openStore(join(home, "warden.db"));
const ctx = { env: { WARDEN_HOME: home }, store: () => store };
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
