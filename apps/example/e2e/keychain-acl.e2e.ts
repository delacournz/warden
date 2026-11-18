import { beforeAll, type Device, describe, expect, type Locator, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use({ ...SPEC_OPTIONS, systemAlerts: "off" });

/** The shim is an iOS simulator feature: an Android run of this suite skips every test. */
const IOS_ONLY = { platforms: ["ios"] } as const;

const SECRET = "warden-secret";

/**
 * Taps a read and waits for the system Face ID sheet: the screen's readout leaves the accessibility tree while the
 * sheet is up. The app never calls `evaluatePolicy` itself; the prompt is the Keychain item's access control, which
 * a simulator only enforces with warden's Keychain ACL shim on (`keychainAcl: true`). The first prompt per install
 * asks "Allow … to use Face ID?" first; `alert("accept")` answers it when it is there.
 */
async function startRead(device: Pick<Device, "alert">, screen: Screen, button: string): Promise<void> {
	const status = screen.getByTestId(ids.keychain.status);
	await screen.getByTestId(button).tap({ until: async () => !(await status.isVisible()) });
	await device.alert("accept");
	await expect(status).toBeHidden();
}

const PRESENT_ATTEMPTS = 3;
const PRESENT_WINDOW_MS = 2_000;

/** Presents a face until `landed` shows: one sent before the sheet's matcher listens is dropped without an error. */
async function presentUntil(present: () => Promise<unknown>, landed: Locator): Promise<void> {
	for (let attempt = 1; attempt <= PRESENT_ATTEMPTS; attempt++) {
		await present();
		if (await landed.isVisible()) return;
		try {
			await expect(landed).toBeVisible({ timeout: PRESENT_WINDOW_MS });
			return;
		} catch {
			// not shown within the window: present again, the last attempt's assertion below reports it
		}
	}
}

/** The readout after a call: the status word and the raw OSStatus. */
async function expectResult(screen: Screen, status: string, code: string): Promise<void> {
	await expect(screen.getByTestId(ids.keychain.status)).toHaveText(status);
	await expect(screen.getByTestId(ids.keychain.code)).toHaveText(code);
}

/**
 * Keychain items behind access control on an iOS simulator with the shim on, on a Face ID device enrolled before the
 * app was installed (`biometrics: true`). Each test leaves the Keychain screen up and Face ID enrolled. Items survive
 * a reinstall on a simulator, so the journey starts by deleting both.
 */
describe.serial("keychain acl", () => {
	beforeAll(async ({ app, device, screen }) => {
		await launch(app, screen);
		await openDeepLink(device, screen, "warden-example://keychain", ids.keychain.screen);
		await screen.getByTestId(ids.keychain.delete).tap();
		await expect(screen.getByTestId(ids.keychain.status)).toHaveText("Deleted");
	});

	test("a secret behind Face ID or the passcode is saved", IOS_ONLY, async ({ screen }) => {
		await screen.getByTestId(ids.keychain.save).tap();
		await expectResult(screen, "Saved", "0");
	});

	test(
		"reading it shows the Face ID sheet, and a matching face returns the secret",
		IOS_ONLY,
		async ({ device, screen }) => {
			await startRead(device, screen, ids.keychain.read);
			await presentUntil(() => device.biometrics.match(), screen.getByTestId(ids.keychain.status));
			await expectResult(screen, "Read", "0");
			await expect(screen.getByTestId(ids.keychain.value)).toHaveText(SECRET);
		}
	);

	test("a face that does not match, then Cancel, is errSecUserCanceled", IOS_ONLY, async ({ device, screen }) => {
		await startRead(device, screen, ids.keychain.read);
		const rejection = screen.getByText("Face Not Recognized");
		await presentUntil(() => device.biometrics.fail(), rejection);
		expect(await device.alert({ button: "Cancel" })).toBe(true);
		await expectResult(screen, "Cancelled", "-128");
	});

	test("a read that may not show UI is errSecInteractionNotAllowed, with no sheet", IOS_ONLY, async ({ screen }) => {
		await screen.getByTestId(ids.keychain.readNoUi).tap();
		await expectResult(screen, "Needs UI", "-25308");
	});

	test("a read on the main thread prompts too, and does not hang the app", IOS_ONLY, async ({ device, screen }) => {
		await startRead(device, screen, ids.keychain.readMain);
		await presentUntil(() => device.biometrics.match(), screen.getByTestId(ids.keychain.status));
		await expectResult(screen, "Read", "0");
	});

	test(
		"a bio-only item reads errSecItemNotFound with no prompt while Face ID is unenrolled",
		IOS_ONLY,
		async ({ device, screen }) => {
			await screen.getByTestId(ids.keychain.saveBio).tap();
			await expectResult(screen, "Saved", "0");
			await device.biometrics.unenroll();
			try {
				await screen.getByTestId(ids.keychain.readBio).tap();
				await expectResult(screen, "Invalidated", "-25300");
			} finally {
				await device.biometrics.enroll();
			}
		}
	);

	test("a re-enrolment invalidates a bio-only item written before it", IOS_ONLY, async ({ device, screen }) => {
		await screen.getByTestId(ids.keychain.saveBio).tap();
		await expectResult(screen, "Saved", "0");
		const state = await device.biometrics.reenroll();
		expect(state.enrolled).toBe(true);
		expect(state.generation).toBeGreaterThan(0);
		await screen.getByTestId(ids.keychain.readBio).tap();
		await expectResult(screen, "Invalidated", "-25300");
	});

	test("a bio-only item written after the re-enrolment reads with Face ID", IOS_ONLY, async ({ device, screen }) => {
		await screen.getByTestId(ids.keychain.saveBio).tap();
		await expectResult(screen, "Saved", "0");
		await startRead(device, screen, ids.keychain.readBio);
		await presentUntil(() => device.biometrics.match(), screen.getByTestId(ids.keychain.status));
		await expectResult(screen, "Read", "0");
	});
});
