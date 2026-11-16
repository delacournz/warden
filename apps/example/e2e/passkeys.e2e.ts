import { type App, beforeAll, type Device, describe, expect, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

const RP_ID = "warden.co.nz";

/** Opens the passkeys screen through its deep link (no sign-in gate). */
async function openPasskeys(app: Pick<App, "open">, device: Pick<Device, "openLink">, screen: Screen): Promise<void> {
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://passkeys", ids.passkeys.screen);
}

/**
 * The example app's real passkey calls (`react-native-passkey`) answered by warden's virtual authenticator, on one
 * launch. The `passkeys` suite turns it on (`conditions.passkeys: "auto"`) before the first launch; the screen checks
 * every response itself (challenge, rp id hash, user presence, ES256 signature) and shows `Rejected` otherwise. A mode a
 * test sets goes back to the suite's `auto` when it ends.
 */
describe.serial("passkeys", () => {
	beforeAll(async ({ app, device, screen }) => {
		await openPasskeys(app, device, screen);
	});

	test("Create passkey saves a credential the authenticator holds", async ({ device, screen }) => {
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("No passkey");
		await screen.getByTestId(ids.passkeys.action).tap();
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("Saved", { timeout: 10_000 });
		const [newest] = await device.passkeys.list({ rpId: RP_ID });
		expect(newest?.userName).toBe("demo@warden.co.nz");
		await expect(screen.getByTestId(ids.passkeys.credential)).toHaveText(newest?.credentialId.slice(0, 8) ?? "");
	});

	test("signing in with it verifies, with user verification", async ({ screen, platform }) => {
		await screen.getByTestId(ids.passkeys.action).tap();
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("Signed in", { timeout: 10_000 });
		await expect(screen.getByTestId(ids.passkeys.uv)).toHaveText("true");
		await expect(screen.getByTestId(ids.passkeys.signCount)).toHaveText("0");
		if (platform === "ios") await expect(screen.getByTestId(ids.passkeys.origin)).toHaveText(`https://${RP_ID}`);
		else await expect(screen.getByTestId(ids.passkeys.origin)).toContainText("android:apk-key-hash:");
	});

	test("Sign out keeps the passkey", async ({ screen }) => {
		await screen.getByTestId(ids.passkeys.action).tap();
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("Saved");
	});

	test("a dismissed sheet is Cancelled", async ({ device, screen }) => {
		await device.passkeys.set({ mode: "cancel" });
		await screen.getByTestId(ids.passkeys.action).tap();
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("Cancelled", { timeout: 10_000 });
		await expect(screen.getByTestId(ids.passkeys.error)).toHaveText("UserCancelled");
	});

	test("without user verification the sign-in still verifies, with uv false", async ({ device, screen }) => {
		await device.passkeys.set({ uv: "skip" });
		await screen.getByTestId(ids.passkeys.action).tap();
		await expect(screen.getByTestId(ids.passkeys.status)).toHaveText("Signed in", { timeout: 10_000 });
		await expect(screen.getByTestId(ids.passkeys.uv)).toHaveText("false");
	});
});
