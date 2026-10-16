import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { joinNative, loadManifest, nativeIndex, parseManifest } from "./manifest";

const root = join(import.meta.dir, "../..");

describe("manifest", () => {
	test("the package manifest maps all 8 ids for all 6 frameworks", () => {
		const m = loadManifest(root);
		for (const fw of ["warden", "maestro", "argent", "agent-device", "tester-army", "detox"] as const) {
			expect(nativeIndex(m, fw).size).toBe(8);
		}
	});
	test("rejects a manifest missing an id", () => {
		const r = parseManifest(JSON.stringify({ tests: {} }));
		expect(r.success).toBe(false);
	});
	test("joinNative fills missing ids and reports unmapped names", () => {
		const m = loadManifest(root);
		const { mapped, unmapped } = joinNative(
			m,
			"maestro",
			[{ nativeName: "sign-in-field-errors" }, { nativeName: "rogue" }],
			(id, t) => ({
				id,
				nativeName: t.nativeName,
				status: "passed",
			})
		);
		expect(unmapped).toEqual(["rogue"]);
		expect(mapped).toHaveLength(8);
		expect(mapped.find((t) => t.id === "sign-in/field-errors")?.status).toBe("passed");
		expect(mapped.find((t) => t.id === "todos/add-complete-filter")?.status).toBe("missing");
	});
});
