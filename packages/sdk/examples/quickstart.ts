/**
 * The quickstart of the docs (`apps/docs/content/docs/sdk/index.mdx`): claim a simulator, install the app, drive it,
 * and let `await using` release everything. Typechecked with the package; run it on a machine with Xcode:
 *
 *   bun packages/sdk/examples/quickstart.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

async function main(): Promise<void> {
	await using warden = createWardenClient({ label: "qa-ios", lockPolicy: "wait" });

	const [lease] = await warden.leases.claim({ platform: "ios", profile: "iphone-17-pro", count: 1 });
	if (!lease) throw new Error("no lease returned");
	await warden.apps.ensure({ lease, project: "." });

	await using session = await warden.sessions.open({ lease, app: "com.acme.app" });
	await session.apps.open();
	const snap = await session.capture.snapshot({ interactiveOnly: true });
	await session.interactions.fill({ selector: "id=email", text: "a@b.co" });
	await session.interactions.press({ ref: "@e3" });
	await session.capture.screenshot({ path: "out.png", scale: 0.5 });
	const logs = await session.devtools.console({ since: snap.takenAt });
	console.log(`${snap.elements.length} elements, ${logs.length} console lines`);
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ""}`);
	else console.error(error);
	process.exit(1);
});
