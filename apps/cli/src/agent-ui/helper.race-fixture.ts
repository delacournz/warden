/**
 * Fixture for `helper.integration.test.ts`: `ensureHelper` for one device from its own process, with a
 * fake `warden-simd` (socket mode) as the helper. Waits for `startAt` so several fixtures collide, drops
 * a marker file per actual spawn, prints `{"ok":true,"spawned":bool}`.
 *
 *   bun helper.race-fixture.ts <home> <udid> <socket> <script.json> <markerDir> <startAt epoch ms>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "@delacour/warden-core/store";
import { defaultHelperDeps, ensureHelper } from "./helper";

const [home, udid, socketPath, script, markerDir, startAt] = process.argv.slice(2);
if (!home || !udid || !socketPath || !script || !markerDir || !startAt) {
	throw new Error("usage: helper.race-fixture.ts <home> <udid> <socket> <script> <markerDir> <startAt>");
}
const fake = join(import.meta.dir, "../../../../packages/e2e/native/scripts/fake-simd.ts");
const store = openStore(join(home, "warden.db"));
const wait = Number(startAt) - Date.now();
if (wait > 0) await Bun.sleep(wait);

const result = await ensureHelper({ env: { WARDEN_HOME: home }, now: Date.now, store: () => store }, udid, {
	socketPath,
	helperPath: "/fake/warden-simd",
	deps: {
		...defaultHelperDeps,
		spawnDetached: (spec) => {
			writeFileSync(join(markerDir, `spawn-${process.pid}`), "");
			return defaultHelperDeps.spawnDetached({
				cmd: [process.execPath, fake, "--script", script, ...spec.cmd.slice(1)],
				logPath: spec.logPath,
			});
		},
	},
});
store.close();
console.log(
	JSON.stringify(result.success ? { ok: true, spawned: result.data.spawned } : { ok: false, error: result.error })
);
