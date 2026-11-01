import { describe, expect, test } from "bun:test";
import { createWardenClient } from "./client";

const enabled = process.env.WARDEN_SDK_DEVICE === "1";
const platform = process.env.WARDEN_SDK_PLATFORM === "ios" ? "ios" : "android";
const app = process.env.WARDEN_SDK_APP ?? "com.android.settings";

describe.skipIf(!enabled)("sdk on a real device (WARDEN_SDK_DEVICE=1)", () => {
	test("claim, open, snapshot, screenshot, dispose", async () => {
		let leaseId = "";
		{
			await using warden = createWardenClient({ label: "sdk-integration", lockPolicy: "wait" });
			const [lease] = await warden.leases.claim({ platform });
			expect(lease).toBeDefined();
			leaseId = lease?.id ?? "";
			await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease>, app });
			await session.apps.open({ app });
			const snap = await session.capture.snapshot({ interactiveOnly: true });
			expect(snap.elements.length).toBeGreaterThan(0);
			const shot = await session.capture.screenshot();
			expect(shot.bytes.length).toBeGreaterThan(0);
		}
		await using again = createWardenClient({ label: "sdk-integration-check" });
		const check = await again.leases.check(leaseId);
		expect(check.state).toBe("missing");
	}, 600_000);
});
