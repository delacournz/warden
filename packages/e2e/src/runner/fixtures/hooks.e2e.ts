import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

beforeAll(() => log("beforeAll root"));
afterAll(() => log("afterAll root"));
beforeEach(() => log("beforeEach root"));
afterEach(() => log("afterEach root"));

describe("outer", () => {
	beforeAll(() => log("beforeAll outer"));
	afterAll(() => log("afterAll outer"));
	beforeEach(() => log("beforeEach outer"));
	afterEach(() => log("afterEach outer"));

	describe("inner", () => {
		beforeEach(() => log("beforeEach inner"));
		afterEach(() => log("afterEach inner"));

		test("runs in order", async ({ platform }) => {
			log(`body ${platform}`);
		});
	});
});
