import { describe, test } from "../../index";

test.use({ actionTimeout: 1111 });

test("file scope", () => undefined);

describe("nested", () => {
	test.use({ assertionTimeout: 222, launch: "none" });
	test("describe scope", () => undefined);
});
