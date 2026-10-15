import { test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

test.use({ launch: "none" });

test("taps a locator through app, device and screen", async ({ screen, device }) => {
	await screen.getByTestId("sign-in").tap();
	const taps = fake.driver?.callsOf("tap") ?? [];
	log(`taps=${taps.length} at ${JSON.stringify(taps[0]?.point)}`);
	log(`welcome=${await screen.getByText("Welcome").isVisible()}`);
	log(`snapshot has button=${(await device.snapshot()).includes("id=sign-in")}`);
});

test("a locator that matches nothing fails with LOCATOR_NOT_FOUND and the screen excerpt", async ({ screen }) => {
	await screen.getByTestId("missing").tap({ timeout: 200 });
});
