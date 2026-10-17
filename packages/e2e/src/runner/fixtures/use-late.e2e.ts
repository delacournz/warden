import { describe, test } from "../../index";

describe("late", () => {
	test("registered before the use", async () => undefined);

	// too late for the test above: bun fixed its timeout when it was registered
	test.use({ timeout: 200_000 });
});

describe("early", () => {
	test.use({ timeout: 200_000 });

	test("registered after the use", async () => undefined);
});
