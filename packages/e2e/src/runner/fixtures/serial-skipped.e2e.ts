import { afterAll, beforeAll, describe, test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const launches = (): number => fake.driver?.callsOf("app.launch").length ?? 0;

describe.serial("all skipped", () => {
	beforeAll(() => log("skipped beforeAll ran"));
	afterAll(() => log("skipped afterAll ran"));
	test.skipIf(true)("one", () => log("one ran"));
	describe("nested", () => {
		beforeAll(() => log("nested beforeAll ran"));
		test("android only", { platforms: ["android"] }, () => log("android only ran"));
	});
});

describe.serial("one runs", () => {
	beforeAll(() => log(`kept beforeAll launches=${launches()}`));
	test.skip("skipped", () => log("skipped ran"));
	describe("nested", () => {
		test("runs", () => log("runs ran"));
	});
});
