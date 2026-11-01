/**
 * Read the current route and the app's native log, share the lease with `warden ui`, and tile simulator windows.
 *
 *   WARDEN_SDK_APP=com.example.app bun packages/sdk/examples/devtools.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

const app = process.env.WARDEN_SDK_APP ?? "com.example.app";

async function main(): Promise<void> {
	await using warden = createWardenClient({ label: "sdk-devtools", lockPolicy: "wait" });
	console.log(`viewer: ${await warden.devices.viewer()}`);

	const [lease] = await warden.leases.claim({ platform: "ios", shared: true });
	if (!lease) throw new Error("no lease returned");
	console.log(`lease ${lease.id} shared: ${lease.shared === true}`);
	await warden.devices.arrange();

	await using session = await warden.sessions.open({ lease, app });
	await session.apps.open({ app });

	console.log(`route: ${(await session.devtools.route()) ?? "unknown"}`);

	const recent = await session.devtools.nativeLogs({ level: "error", limit: 20 });
	for (const line of recent) console.log(`${new Date(line.ts).toISOString()} ${line.level} ${line.text}`);

	const stop = new AbortController();
	setTimeout(() => stop.abort(), 10_000);
	for await (const line of session.devtools.nativeLogs({ follow: true }, { signal: stop.signal })) {
		console.log(`live ${line.level} ${line.text}`);
	}
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code} (dispatched: ${error.dispatched}): ${error.message}`);
	else console.error(error);
	process.exitCode = 1;
});
