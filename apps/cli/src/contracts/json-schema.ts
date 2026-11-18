import { join } from "node:path";
import { z } from "zod";
import { CONTRACTS, publishedSchemas } from "./registry.schema";
import { SCHEMA_BASE_URL, schemaUrl } from "./versions";

/** Where the generated files live in the repo: served by the docs site at `https://warden.co.nz/schemas/…`. */
export const PUBLISHED_DIR = join(import.meta.dir, "../../../docs/public/schemas");

export type SchemaFile = { path: string; text: string };

const json = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

/**
 * Every published contract as JSON Schema (draft 2020-12), `<schema>/<version>.json`, plus `index.json` naming each
 * contract, the command that prints it and where. `scripts/contracts/generate.ts` writes them; the drift test
 * compares them, so a schema change without a regenerate fails CI.
 */
export function renderSchemaFiles(): SchemaFile[] {
	const files = publishedSchemas().map(({ schema, version, zod }) => ({
		path: `${schema}/${version}.json`,
		text: json({
			...z.toJSONSchema(zod, { target: "draft-2020-12" }),
			$id: schemaUrl(schema, version),
			title: schema,
		}),
	}));
	const index = {
		base: SCHEMA_BASE_URL,
		contracts: CONTRACTS.map((c) => ({
			command: c.command,
			schema: c.schema,
			version: c.version,
			url: schemaUrl(c.schema, c.version),
			output: c.output.kind === "file" ? `file:${c.output.file}` : c.output.kind,
			summary: c.summary,
		})),
	};
	return [...files, { path: "index.json", text: json(index) }];
}
