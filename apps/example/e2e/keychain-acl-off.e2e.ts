import { describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use({ ...SPEC_OPTIONS, systemAlerts: "off" });

/** The shim is an iOS simulator feature: an Android run of this suite skips every test. */
const IOS_ONLY = { platforms: ["ios"] } as const;

/**
 * The negative control for `keychain-acl`: the same screen with the shim off (`keychainAcl: false`). A simulator
 * ignores `SecAccessControl`, so the read returns the secret at once with no Face ID sheet, which is the gap the shim
 * closes: the prompt in `keychain-acl` comes from warden's shim, not from the app.
 */
describe.serial("keychain acl off", () => {
	test("a secret behind Face ID reads back with no prompt", IOS_ONLY, async ({ app, device, screen }) => {
		await launch(app, screen);
		await openDeepLink(device, screen, "warden-example://keychain", ids.keychain.screen);
		await screen.getByTestId(ids.keychain.save).tap();
		await expect(screen.getByTestId(ids.keychain.status)).toHaveText("Saved");
		await screen.getByTestId(ids.keychain.read).tap();
		await expect(screen.getByTestId(ids.keychain.status)).toHaveText("Read");
		await expect(screen.getByTestId(ids.keychain.value)).toHaveText("warden-secret");
		await expect(screen.getByTestId(ids.keychain.readNoUi)).toBeVisible();
		await screen.getByTestId(ids.keychain.readNoUi).tap();
		await expect(screen.getByTestId(ids.keychain.code)).toHaveText("0");
	});
});
