/**
 * Time a cold start, record a short perf session around a few seconds of use and print what it found.
 *
 *   WARDEN_SDK_APP=com.acme.shop bun packages/sdk/examples/perf.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

async function main(): Promise<void> {
	const app = process.env.WARDEN_SDK_APP;
	if (!app) throw new Error("set WARDEN_SDK_APP to the bundle id / package to profile");
	const platform = process.env.WARDEN_SDK_PLATFORM === "ios" ? "ios" : "android";

	await using warden = createWardenClient({ label: "sdk-perf-example", lockPolicy: "wait" });
	const [lease] = await warden.leases.claim({ platform });
	if (!lease) throw new Error("no lease");
	await using session = await warden.sessions.open({ lease, app });

	const startup = await session.perf.startup({ runs: 3 });
	console.log(`cold start median ${startup.summary.cold?.medianMs ?? "?"} ms`);

	await session.perf.start({ metrics: true, frames: true, logs: true });
	await session.perf.mark("idle");
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	const stopped = await session.perf.stop();
	for (const line of stopped.report?.summary ?? []) console.log(line);
	for (const finding of stopped.report?.findings ?? []) {
		console.log(`${finding.severity.padEnd(8)} ${finding.kind}: ${finding.evidence}`);
	}

	const crashes = await session.perf.crashes();
	console.log(`${crashes.count} crash(es) or ANR(s)`);
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code}: ${error.message}`);
	else console.error(error);
	process.exit(1);
});
