import { describe, test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const launches = (): number => fake.driver?.callsOf("app.launch").length ?? 0;

describe("chain", { serial: true }, () => {
	test.use({ launch: "none" });
	test("first", () => log(`first launches=${launches()}`));
	test("second", () => log(`second launches=${launches()}`));
});
