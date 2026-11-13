import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACTS } from "./registry.schema";

export const FIXTURES_DIR = join(import.meta.dir, "fixtures");

/** Set to rewrite `fixtures/<schema>/<name>.json` from the runs the command tests make. */
const UPDATE = process.env.WARDEN_UPDATE_CONTRACT_FIXTURES === "1";

/** The zod schema published as `schema`. */
export function contractSchema(schema: string) {
	const found = CONTRACTS.find((c) => c.schema === schema);
	if (!found) throw new Error(`no contract ${schema} in registry.schema.ts`);
	return found.zod;
}

/** A test's `mkdtemp` dir (`warden-cli-Ab12Cd`, `warden-e2e-…`), wherever the OS keeps temp files. */
const TEMP_DIR = new RegExp(
	`(?:/private)?${escapeRe(tmpdir())}/warden-[\\w-]*?[A-Za-z0-9]{6}(?=/|$)|/tmp/warden-[\\w-]*?[A-Za-z0-9]{6}(?=/|$)`,
	"g"
);

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Temp dirs and the clock make each run differ: fixtures keep the shape, not those values. */
function normalize(value: unknown, paths: ReadonlyArray<[string, string]>): unknown {
	if (typeof value === "string")
		return paths
			.reduce((s, [from, to]) => s.replaceAll(from, to), value)
			.replace(TEMP_DIR, "/tmp/warden")
			.replace(/warden-(cli|e2e)-[A-Za-z0-9]{6}/g, "warden-$1-XXXXXX");
	if (Array.isArray(value)) return value.map((v) => normalize(v, paths));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, paths)]));
	return value;
}

/**
 * A command's real `--json` output must parse under its published schema (strict: no field the schema lacks).
 * With `WARDEN_UPDATE_CONTRACT_FIXTURES=1` the document is also saved as the fixture `<schema>/<name>.json`,
 * temp paths in `paths` replaced so the file is stable.
 */
export function expectContract(
	schema: string,
	doc: unknown,
	fixture?: { name: string; paths?: ReadonlyArray<[string, string]> }
): void {
	const parsed = contractSchema(schema).safeParse(doc);
	expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	if (!UPDATE || fixture === undefined) return;
	const dir = join(FIXTURES_DIR, schema);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${fixture.name}.json`),
		`${JSON.stringify(normalize(doc, fixture.paths ?? []), null, "\t")}\n`
	);
}
