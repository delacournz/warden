import { beforeAll, describe, test } from "../../index";
import type { Screen } from "../../runner/fixtures.types";

let saved: Screen | undefined;

describe("stash", () => {
	beforeAll(({ screen }) => {
		saved = screen;
	});
	test("uses the beforeAll screen", async () => {
		await saved?.getByText("Welcome").isVisible();
	});
});
