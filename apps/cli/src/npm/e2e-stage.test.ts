import { describe, expect, test } from "bun:test";
import { e2eDependencies } from "./e2e-stage";

describe("e2eDependencies", () => {
	test("zod keeps the range packages/e2e declares; bun:test is the runtime's and not a dependency", () => {
		expect(e2eDependencies(JSON.stringify({ dependencies: { zod: "^4.4.3", typescript: "^5.9.3" } }))).toEqual({
			success: true,
			data: { zod: "^4.4.3" },
		});
	});

	test("an external the package does not declare is an error", () => {
		const result = e2eDependencies(JSON.stringify({ dependencies: {} }));
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("no dependency zod");
	});
});
