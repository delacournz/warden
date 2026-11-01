/**
 * Test fixture for `store.test.ts`: a lease holder in its own process. Heartbeats `<lease-id>` with
 * period `<period-ms>` every `<every-ms>`, at most `<beats>` times, printing each beat's updated row
 * count; stops at the first beat that updates nothing (the lease was reclaimed or released).
 */
import { openStore } from "./store";

const [dbPath, leaseId, periodArg, everyArg, beatsArg] = process.argv.slice(2);
if (!dbPath || !leaseId || !periodArg || !everyArg || !beatsArg) {
	throw new Error("usage: heartbeat.race-fixture.ts <db> <lease-id> <period-ms> <every-ms> <beats>");
}
const store = openStore(dbPath);
for (let i = 0; i < Number(beatsArg); i++) {
	const updated = store.heartbeat([leaseId], Date.now(), Number(periodArg));
	console.log(updated);
	if (updated === 0) break;
	Bun.sleepSync(Number(everyArg));
}
store.close();
