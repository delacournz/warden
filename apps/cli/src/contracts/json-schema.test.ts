import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PUBLISHED_DIR, renderSchemaFiles } from "./json-schema";

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [relative(PUBLISHED_DIR, join(dir, e.name))]
	);
}

const REGENERATE = "stale: run `bun scripts/contracts/generate.ts` and commit apps/docs/public/schemas";

describe("published JSON Schemas (apps/docs/public/schemas)", () => {
	const files = renderSchemaFiles();

	test("every contract is generated and current", () => {
		const stale = files
			.filter((f) => {
				const path = join(PUBLISHED_DIR, f.path);
				return !existsSync(path) || readFileSync(path, "utf8") !== f.text;
			})
			.map((f) => f.path);
		expect(stale, REGENERATE).toEqual([]);
	});

	test("nothing published that no contract generates", () => {
		const expected = new Set(files.map((f) => f.path));
		expect(
			walk(PUBLISHED_DIR).filter((p) => !expected.has(p)),
			REGENERATE
		).toEqual([]);
	});

	test("each schema names its own URL and rejects unknown fields at the top", () => {
		const claim = JSON.parse(files.find((f) => f.path === "warden.claim/1.json")?.text ?? "{}");
		expect(claim.$id).toBe("https://warden.co.nz/schemas/warden.claim/1.json");
		expect(claim.additionalProperties).toBe(false);
		expect(claim.properties.schemaVersion).toEqual({ type: "number", const: 1 });
	});
});
