/**
 * Regenerate the published JSON Schemas of the CLI's `--json` outputs into `apps/docs/public/schemas/`
 * (served at https://warden.co.nz/schemas/<schema>/<version>.json). Run after changing `apps/cli/src/contracts/*.schema.ts`:
 * `bun scripts/contracts/generate.ts`. The CLI's `json-schema.test.ts` fails while the files are stale.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PUBLISHED_DIR, renderSchemaFiles } from "../../apps/cli/src/contracts/json-schema";

const files = renderSchemaFiles();
const keep = new Set(files.map((f) => f.path));

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [relative(PUBLISHED_DIR, join(dir, e.name))]
	);
}

mkdirSync(PUBLISHED_DIR, { recursive: true });
for (const stale of walk(PUBLISHED_DIR).filter((p) => !keep.has(p))) rmSync(join(PUBLISHED_DIR, stale));
for (const file of files) {
	const path = join(PUBLISHED_DIR, file.path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, file.text);
}
console.log(`wrote ${files.length} files to ${relative(process.cwd(), PUBLISHED_DIR)}`);
