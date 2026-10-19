import { setTimeout as sleep } from "node:timers/promises";
import { E2eError } from "../../errors";
import { afterEach, describe, test } from "../../index";
import { setRunnerTiming } from "../attempt";
import type { Screen } from "../fixtures.types";
import { fixtureLog as log } from "./fake-setup";

// an `afterEach` gets 200 ms before the runner gives up on it (and moves on while it keeps running)
setRunnerTiming({ cleanupTimeoutMs: 200 });

/** A tap from work the runner already gave up on: logs whether it reached the device. */
async function lateTap(who: string, screen: Screen): Promise<void> {
	try {
		await screen.getByText("Welcome").tap();
		log(`${who} tap passed`);
	} catch (error) {
		log(`${who} tap rejected ${error instanceof E2eError ? error.code : String(error)}`);
	}
}

describe("body", () => {
	test.use({ timeout: 300, launch: "none" });

	// sleeps through its deadline (a wait that ignores the signal), then taps
	test("sleeps past its deadline then taps", async ({ screen }) => {
		await sleep(600);
		await lateTap("body", screen);
	});

	test("runs while the zombie body taps", { timeout: 5_000 }, async () => {
		await sleep(1_000);
		log("victim of the body done");
	});
});

describe("hook", () => {
	test.use({ launch: "none" });

	afterEach(async ({ screen }) => {
		await sleep(600);
		await lateTap("afterEach", screen);
	});

	test("its afterEach outlives the cleanup limit", async () => undefined);
});

describe("after the hook", () => {
	test.use({ launch: "none" });

	test("runs while the zombie afterEach taps", async () => {
		await sleep(1_000);
		log("victim of the hook done");
	});
});
