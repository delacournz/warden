/**
 * Record a session as an e2e spec: drive the app, then write `<suite specsDir>/<name>.e2e.ts`.
 *
 *   WARDEN_SDK_PLATFORM=ios WARDEN_SDK_APP=com.apple.Preferences bun packages/sdk/examples/record.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

const platform = process.env.WARDEN_SDK_PLATFORM === "android" ? "android" : "ios";
const app = process.env.WARDEN_SDK_APP ?? "com.apple.Preferences";

async function main(): Promise<void> {
	await using warden = createWardenClient({ label: "sdk-record-example", lockPolicy: "wait" });
	const [lease] = await warden.leases.claim({ platform });
	if (!lease) throw new Error("no lease returned");
	await using session = await warden.sessions.open({ lease, app });

	await session.record.start({ name: "open first row", overwrite: true });
	await session.apps.open({ app });
	await session.capture.snapshot({ interactiveOnly: true });
	await session.record.note("open the first row");
	const snapshot = await session.capture.snapshot({ interactiveOnly: true });
	const first = snapshot.elements[0];
	if (first) await session.interactions.press({ ref: first.ref });

	const status = await session.record.status();
	console.log(status.outcome === "recording" ? `${status.recording.steps} steps so far` : "not recording");

	const stopped = await session.record.stop({ verify: false });
	console.log(`wrote ${stopped.file} (${stopped.steps} steps, ${stopped.lints.length} lint findings)`);
	if (stopped.configSnippet) console.log(stopped.configSnippet);
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ""}`);
	else console.error(error);
	process.exit(1);
});
