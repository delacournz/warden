/**
 * Contracts of the docs (`contracts.mdx`): parse the `--json` output of the `warden` binary with the published zod
 * schemas, from any tool that shells out. Needs a `warden` on PATH.
 *
 *   bun packages/sdk/examples/shell-integration.ts
 */
import { claimJsonSchema, lsJsonSchema, releaseJsonSchema } from "../src/contracts/index";

async function warden(...args: string[]): Promise<unknown> {
	const proc = Bun.spawn(["warden", ...args, "--json"], { stdout: "pipe", stderr: "inherit" });
	const text = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error(`warden ${args.join(" ")} failed: ${text}`);
	return JSON.parse(text);
}

const claim = claimJsonSchema.parse(await warden("claim", "ios"));
const [leased] = claim.leases;
if (!leased) throw new Error("claim returned no lease");
console.log(`claimed ${leased.name} (${leased.udid}), ${leased.action}`);

const ls = lsJsonSchema.parse(await warden("ls"));
console.log(`${ls.leases.filter((lease) => lease.state === "alive").length} live leases on the machine`);

const released = releaseJsonSchema.parse(await warden("release", leased.leaseId));
console.log(`released ${JSON.stringify(released)}`);
