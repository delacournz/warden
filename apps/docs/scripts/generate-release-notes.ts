/**
 * Writes `content/docs/release-notes.md` from `apps/cli/CHANGELOG.md` and the pending
 * `.changeset/*.md` files (see `src/lib/release-notes.ts`). Run by `bun run release-notes`, which
 * `dev` and `build` run first (see package.json). The page is gitignored.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PendingChangeset, parseChangelog, parseChangeset, renderReleaseNotes } from "../src/lib/release-notes";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const CHANGELOG = join(ROOT, "apps/cli/CHANGELOG.md");
const CHANGESETS = join(ROOT, ".changeset");
const OUT = join(HERE, "../content/docs/release-notes.md");

const pending = readdirSync(CHANGESETS)
	.filter((file) => file.endsWith(".md") && file !== "README.md")
	.sort()
	.flatMap((file): PendingChangeset[] => {
		const changeset = parseChangeset(readFileSync(join(CHANGESETS, file), "utf8"));
		return changeset ? [changeset] : [];
	});

const releases = parseChangelog(readFileSync(CHANGELOG, "utf8"));

writeFileSync(OUT, renderReleaseNotes({ releases, pending }));
console.log(`release notes: ${releases.length} releases, ${pending.length} pending → ${OUT}`);
