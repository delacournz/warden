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

/** How many lines of a page's code its card shows. */
export const PROOF_LINES = 8;

const SHELL = new Set(["bash", "sh", "shell", "zsh", "console"]);

/**
 * What stands in the right column of a page's card, the way a hero capture stands in Delacour UI's:
 * the page's first code block with something to show (a shell block as the commands it runs,
 * anything else as written), or, on a page with no code, its `##` / `###` headings.
 */
export type CardProof =
	| { kind: "shell"; lines: string[] }
	| { kind: "code"; lang: string; lines: string[] }
	| { kind: "outline"; headings: string[] };

/** A block shorter than this (an install line) gives way to the next one that says more. */
const PROOF_MIN_LINES = 3;

type Fence = { lang: string; lines: string[] };

/** Every fenced block, each dedented by its fence's indent (a fence inside `<Tab>` or `<Step>`). */
function fences(source: string): Fence[] {
	const found: Fence[] = [];
	let open: { indent: string; lang: string; lines: string[] } | undefined;
	for (const line of source.split(/\r?\n/)) {
		if (!open) {
			const fence = /^(\s*)```(\w*)/.exec(line);
			if (fence) open = { indent: fence[1], lang: fence[2], lines: [] };
		} else if (/^\s*```\s*$/.test(line)) {
			found.push({ lang: open.lang, lines: open.lines });
			open = undefined;
		} else {
			open.lines.push(line.startsWith(open.indent) ? line.slice(open.indent.length) : line);
		}
	}
	return found;
}

/** A block as the card shows it: a shell block as its commands, anything else as written. */
function proofOfFence({ lang, lines }: Fence): CardProof {
	if (SHELL.has(lang)) {
		const commands = lines
			.map((line) => line.replace(/\s+#\s.*$/, "").trimEnd())
			.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
		return { kind: "shell", lines: commands.slice(0, PROOF_LINES) };
	}

	const code = lines.map((line) => line.replace(/\t/g, "  ").trimEnd());
	while (code[0] === "") code.shift();
	while (code.at(-1) === "") code.pop();
	return { kind: "code", lang, lines: code.slice(0, PROOF_LINES) };
}

/** Inline markdown down to its text: code ticks, links and emphasis dropped. */
function plain(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim();
}

export function cardProof(source: string): CardProof {
	const proofs = fences(source).map(proofOfFence);
	const size = (proof: CardProof) => (proof.kind === "outline" ? proof.headings : proof.lines).length;
	const proof = proofs.find((candidate) => size(candidate) >= PROOF_MIN_LINES) ?? proofs[0];
	if (proof) return proof;

	const headings = [...source.matchAll(/^(##|###) (.+)$/gm)].map(
		([, depth, text]) => `${depth === "###" ? "  " : ""}${plain(text)}`
	);
	return { kind: "outline", headings: headings.slice(0, PROOF_LINES) };
}

/** A `meta.json` as far as the cards read it. The root's is keyed `""`, a folder's by its name. */
export type Meta = { title?: string; pages?: string[] };

/**
 * The sidebar section a page sits in, for the card's eyebrow: a folder's own title, or for a page
 * at the root, the `---Separator---` above it in the root's `pages`.
 */
export function sectionOf(slugs: readonly string[], metas: Record<string, Meta>): string | undefined {
	const [first] = slugs;
	if (first !== undefined && metas[first]?.title) return metas[first].title;

	const pages = metas[""]?.pages ?? [];
	const at = pages.indexOf(first ?? "index");
	if (at < 0) return undefined;

	for (let i = at; i >= 0; i--) {
		const separator = /^---(.+)---$/.exec(pages[i]);
		if (separator) return separator[1];
	}
	return undefined;
}
