import { describe, test } from "../../index";

describe.serial("chain", () => {
	test("retried", { retry: 1 }, () => undefined);
});
