import { test } from "../../index";

let attempts = 0;

test("flaky", { retry: 2 }, async () => {
	attempts += 1;
	if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
});
