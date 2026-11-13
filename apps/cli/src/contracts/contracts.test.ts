import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contractSchema, FIXTURES_DIR } from "./contracts.testing";
import { CONTRACTS, publishedSchemas } from "./registry.schema";
import { SCHEMA_VERSIONS } from "./versions";

const fixtureDirs = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR) : [];

describe("JSON output contracts", () => {
	test("every published schema has at least one fixture captured from a real run", () => {
		const missing = publishedSchemas()
			.map((s) => s.schema)
			.filter((s) => !fixtureDirs.includes(s) || readdirSync(join(FIXTURES_DIR, s)).length === 0);
		expect(missing, "run the command tests with WARDEN_UPDATE_CONTRACT_FIXTURES=1").toEqual([]);
	});

	test("every fixture dir names a published schema", () => {
		const names = new Set(CONTRACTS.map((c) => c.schema));
		expect(fixtureDirs.filter((d) => !names.has(d))).toEqual([]);
	});

	for (const dir of fixtureDirs) {
		for (const file of readdirSync(join(FIXTURES_DIR, dir))) {
			test(`fixtures/${dir}/${file} parses under ${dir}`, () => {
				const doc: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, dir, file), "utf8"));
				const parsed = contractSchema(dir).safeParse(doc);
				expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
			});
		}
	}

	test("a versioned object carries the registry's schemaVersion", () => {
		for (const c of CONTRACTS) {
			const family = Object.keys(SCHEMA_VERSIONS).find((f) => c.schema === f || c.schema.startsWith(`${f}.`));
			expect(family, c.schema).toBeDefined();
			expect(c.version).toBe(SCHEMA_VERSIONS[family as keyof typeof SCHEMA_VERSIONS]);
		}
	});

	test("schemas are strict: an unknown field is rejected", () => {
		const claim = contractSchema("warden.claim");
		const doc = { schemaVersion: 1, leases: [], udids: [], reclaimed: [] };
		expect(claim.safeParse(doc).success).toBe(true);
		expect(claim.safeParse({ ...doc, extra: 1 }).success).toBe(false);
		expect(claim.safeParse({ ...doc, schemaVersion: 2 }).success).toBe(false);
	});
});
