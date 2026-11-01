import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, test } from "../../index";
import { attemptRunner } from "../attempt";
import { fixtureLog } from "./fake-setup";

// bun's own timeout is the test's + 1.5 s; the runner keeps 0.5 s of that for itself, and allows 0.8 s per hook
attemptRunner.setRunnerTiming({ bunMarginMs: 1_500, reserveMs: 500, cleanupTimeoutMs: 800 });

describe("slow", () => {
	test.use({ timeout: 100, launch: "none" });

	// four hooks of 0.7 s: each fits its own limit, together they overrun bun's margin
	for (const n of [1, 2, 3, 4]) {
		afterEach(async () => {
			await sleep(700);
			fixtureLog.write(`afterEach ${n} done`);
		});
	}

	test("slow cleanup", () => new Promise<void>(() => undefined));
});

describe("then", () => {
	test.use({ launch: "none" });

	test("next", { timeout: 5_000 }, async () => {
		fixtureLog.write("next body");
	});
});
