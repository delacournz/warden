/**
 * Test fixture for `store.test.ts`: read leases, sleep to widen the race window, then lease the
 * first free port in 9000–9019. Prints the port. Run as a separate process.
 */
import { openStore } from "./store";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: store.race-fixture.ts <db>");
const store = openStore(dbPath);
const port = store.transaction(() => {
	const taken = new Set(store.listLeases().flatMap((l) => (l.resource.kind === "port" ? [l.resource.port] : [])));
	Bun.sleepSync(30);
	for (let p = 9000; p < 9020; p++) {
		if (taken.has(p)) continue;
		store.insertLease(
			{ resource: { kind: "port", port: p }, owner: { kind: "ci", runId: `${process.pid}` }, ttlMs: 60_000 },
			Date.now()
		);
		return p;
	}
	throw new Error("no free port");
});
store.close();
console.log(port);
