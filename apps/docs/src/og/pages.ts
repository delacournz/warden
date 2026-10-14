/**
 * The docs pages an OpenGraph card is drawn for, read straight from `content/docs` frontmatter so
 * `scripts/generate-og.ts` runs before (and without) the Vite build that compiles the MDX.
 */

export type Frontmatter = Record<string, string>;

/** The leading `---` block as flat `key: value` pairs, which is all the docs frontmatter uses. */
export function parseFrontmatter(source: string): Frontmatter {
	const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	if (!block) return {};

	const fields: Frontmatter = {};
	for (const line of block[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const value = line.slice(colon + 1).trim();
		const quoted = /^(["'])(.*)\1$/.exec(value);
		fields[line.slice(0, colon).trim()] = quoted ? quoted[2] : value;
	}
	return fields;
}

/** A content file's path under `content/docs` as Fumadocs slugs: `index` names its folder. */
export function slugsForFile(relativePath: string): string[] {
	const slugs = relativePath
		.replace(/\.mdx?$/, "")
		.split(/[\\/]/)
		.filter(Boolean);
	if (slugs.at(-1) === "index") slugs.pop();
	return slugs;
}

/** Truncate at the last word boundary that fits, so a card never ends mid-word. */
export function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max - 1);
	const lastSpace = head.lastIndexOf(" ");
	return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd().replace(/[,;:—-]$/, "")}…`;
}
