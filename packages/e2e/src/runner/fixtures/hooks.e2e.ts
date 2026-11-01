import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "../../index";
import { fixtureLog } from "./fake-setup";

beforeAll(() => fixtureLog.write("beforeAll root"));
afterAll(() => fixtureLog.write("afterAll root"));
beforeEach(() => fixtureLog.write("beforeEach root"));
afterEach(() => fixtureLog.write("afterEach root"));

describe("outer", () => {
	beforeAll(() => fixtureLog.write("beforeAll outer"));
	afterAll(() => fixtureLog.write("afterAll outer"));
	beforeEach(() => fixtureLog.write("beforeEach outer"));
	afterEach(() => fixtureLog.write("afterEach outer"));

	describe("inner", () => {
		beforeEach(() => fixtureLog.write("beforeEach inner"));
		afterEach(() => fixtureLog.write("afterEach inner"));

		test("runs in order", async ({ platform }) => {
			fixtureLog.write(`body ${platform}`);
		});
	});
});
