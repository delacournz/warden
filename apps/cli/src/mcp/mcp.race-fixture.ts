/**
 * Fixture for `mcp.integration.test.ts`: an intermediate parent. Spawns `warden mcp` reading `<fifo>` (whose write end
 * the test holds) and writing `<out>`, prints the child's pid, then waits. SIGKILL this process and the child is
 * orphaned with its stdin still open, so only the parent-pid poll can end it.
 *
 *   bun mcp.race-fixture.ts <fifo> <out>
 */
import { openSync } from "node:fs";
import { join } from "node:path";

const [fifo, out] = process.argv.slice(2);
if (!fifo || !out) throw new Error("usage: mcp.race-fixture.ts <fifo> <out>");
const child = Bun.spawn([process.execPath, join(import.meta.dir, "../cli.ts"), "mcp"], {
	stdin: openSync(fifo, "r"),
	stdout: openSync(out, "w"),
	stderr: "ignore",
	env: process.env,
});
console.log(child.pid);
await child.exited;
