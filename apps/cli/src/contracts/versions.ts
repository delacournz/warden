/**
 * The `schemaVersion` every versioned `--json` document carries, by schema name. Zod-free on purpose: emit sites
 * import this (a value) and the matching `*.schema.ts` only as `import type`, so `claim`, `release` and `ui` never
 * load zod on a cold start. Bump a version only for a breaking change (a field removed, renamed or retyped); adding
 * an optional field is not one. A bump keeps the old schema file and adds the new one beside it.
 */
export const SCHEMA_VERSIONS = {
	"warden.failure": 1,
	"warden.claim": 1,
	"warden.release": 1,
	"warden.ui": 1,
	"warden.e2e.report": 1,
	"warden.e2e.event": 1,
	"warden.e2e.result": 1,
	"warden.app.ensure": 1,
	"warden.dev": 1,
} as const;

export type SchemaName = keyof typeof SCHEMA_VERSIONS;

/** Where the generated JSON Schema of `<schema>` version `<n>` is published. */
export const SCHEMA_BASE_URL = "https://warden.co.nz/schemas";

export function schemaUrl(schema: string, version: number): string {
	return `${SCHEMA_BASE_URL}/${schema}/${version}.json`;
}
