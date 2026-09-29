/**
 * Test fixture for `lock.test.ts`: resolve an app for hash `H` via `ensureApp` against the shared
 * store in `<home>`, with a fake eas-cli whose `build:download` is slow and appends a line to
 * `<counter>`. Prints the `EnsureResult` JSON. Run two at once → exactly one download.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { processAlive } from "../liveness";
import { openStore } from "../store";
import { fakeApp, testProject } from "./builds.testing";
import { ensureApp } from "./ensure";

const [home, counter] = process.argv.slice(2);
if (!home || !counter) throw new Error("usage: lock.race-fixture.ts <home> <counter>");

const exec: Exec = async (cmd) => {
	const joined = cmd.join(" ");
	if (joined.includes("build:list")) {
		const build = {
			id: "b1",
			status: "FINISHED",
			createdAt: "2026-09-01T00:00:00Z",
			isForIosSimulator: true,
			artifacts: { applicationArchiveUrl: "https://x/b1.tar.gz" },
		};
		return { exitCode: 0, stdout: JSON.stringify([build]), stderr: "" };
	}
	if (joined.includes("build:download")) {
		appendFileSync(counter, `${process.pid}\n`);
		await Bun.sleep(400);
		const app = fakeApp(mkdtempSync(join(tmpdir(), "warden-race-dl-")));
		return { exitCode: 0, stdout: JSON.stringify({ path: app }), stderr: "" };
	}
	return { exitCode: 127, stdout: "", stderr: `unexpected ${joined}` };
};

const store = openStore(join(home, "warden.db"));
const res = await ensureApp({
	store,
	exec,
	env: { WARDEN_HOME: home },
	now: () => Date.now(),
	sleep: (ms) => Bun.sleep(ms),
	log: () => {},
	pidAlive: processAlive,
	owner: { kind: "ci", runId: `race-${process.pid}` },
	pid: process.pid,
	project: testProject({ eas: { profile: "development-simulator", trigger: false } }),
	projectKey: "github.com/o/r:app",
	platform: "ios",
	hash: "H",
	eas: true,
	build: false,
	lockPollMs: 20,
});
store.close();
console.log(JSON.stringify(res));
