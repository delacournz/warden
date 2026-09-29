/**
 * Test fixture for `ports.test.ts`: claim one port in 47100–47119 via `claimPorts` (fake probe that
 * sleeps to widen the race window). Prints the port. Run as a separate process.
 */
import { claimPorts } from "./ports";
import { openStore } from "./store";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: ports.race-fixture.ts <db>");
const store = openStore(dbPath);
const res = await claimPorts(
	store,
	{ owner: { kind: "ci", runId: `${process.pid}` }, from: 47_100, span: 20, ttlMs: 60_000 },
	{
		now: () => Date.now(),
		pidAlive: () => true,
		isPortFree: async () => {
			await Bun.sleep(5);
			return true;
		},
	}
);
store.close();
if (!res.success) throw new Error(res.error);
const port = res.data[0]?.resource.kind === "port" ? res.data[0].resource.port : undefined;
console.log(port);
