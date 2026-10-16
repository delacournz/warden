import { E2eError, test } from "../../index";

test("throws an E2eError", async () => {
	throw new E2eError("ASSERTION", "expected visible");
});

test("throws a plain error synchronously", () => {
	throw new Error("plain");
});
