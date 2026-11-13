import { beforeAll, describe, test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

describe("broken sign-in", () => {
	beforeAll(async ({ screen }) => {
		await screen.getByText("Sign in").tap();
		throw new Error("sign-in broke");
	});
	test("never runs", () => log("never runs ran"));
});

describe("hung sign-in", () => {
	test.use({ timeout: 300 });
	beforeAll(() => new Promise<void>(() => undefined));
	test("never runs either", () => log("never runs either ran"));
});

describe("fine", () => {
	beforeAll(() => log("fine beforeAll"));
	test("runs", () => log("runs ran"));
});
