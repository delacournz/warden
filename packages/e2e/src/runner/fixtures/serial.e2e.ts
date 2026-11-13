import { afterAll, beforeAll, describe, test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const launches = (): number => fake.driver?.callsOf("app.launch").length ?? 0;

describe.serial("sign-in group", () => {
	beforeAll(async ({ screen }) => {
		log(`beforeAll launches=${launches()}`);
		await screen.getByText("Sign in").tap();
	});
	afterAll(() => log(`afterAll launches=${launches()}`));

	test("first", () => log(`first launches=${launches()}`));
	test("second fails", () => {
		log("second");
		throw new Error("second broke");
	});
	test("third", () => log("third ran"));

	describe("nested", () => {
		test("fourth", () => log("fourth ran"));
	});
});

test("outside the group", () => log(`outside launches=${launches()}`));
