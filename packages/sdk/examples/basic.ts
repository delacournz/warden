/**
 * Claim a device, open an app, read the screen and tap the first interactive element, then release everything.
 *
 *   WARDEN_SDK_PLATFORM=android WARDEN_SDK_APP=com.android.settings bun packages/sdk/examples/basic.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

const platform = process.env.WARDEN_SDK_PLATFORM === "ios" ? "ios" : "android";
const app = process.env.WARDEN_SDK_APP ?? "com.android.settings";

async function main(): Promise<void> {
	await using warden = createWardenClient({
		label: "sdk-example",
		lockPolicy: "wait",
		onEvent: (event) => console.error(`[warden] ${event.kind}`),
	});
	const [lease] = await warden.leases.claim({ platform });
	if (!lease) throw new Error("no lease returned");
	await using session = await warden.sessions.open({ lease, app });
	await session.apps.open({ app });
	const snapshot = await session.capture.snapshot({ interactiveOnly: true });
	console.log(`${snapshot.elements.length} interactive elements`);
	const first = snapshot.elements[0];
	if (first) await session.interactions.press({ ref: first.ref });
	const shot = await session.capture.screenshot({ path: "/tmp/warden-sdk-example.png" });
	console.log(`screenshot ${shot.width}x${shot.height}`);
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code} (dispatched: ${error.dispatched}): ${error.message}`);
	else console.error(error);
	process.exit(1);
});
