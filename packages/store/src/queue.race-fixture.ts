/**
 * Test fixture for `store.test.ts`: read the queue, sleep to widen the race window, then enqueue
 * a row with the given id. Run as a separate process.
 */
import { openStore } from "./store";

const dbPath = process.argv[2];
const id = process.argv[3];
if (!dbPath || !id) throw new Error("usage: queue.race-fixture.ts <db> <id>");
const store = openStore(dbPath);
store.transaction(() => {
	store.listQueue();
	Bun.sleepSync(30);
	store.enqueue({
		id,
		platform: "ios",
		profile: "iphone-17",
		units: 1,
		priority: 10,
		enqueuedAt: Date.now(),
		heartbeatAt: Date.now(),
		owner: { kind: "ci", runId: id },
	});
});
store.close();
