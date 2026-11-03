import type { Element, ElementContent, Root, RootContent } from "hast";

/**
 * Deep links into reference tables. Headings already carry Fumadocs' anchors, but most of what a
 * reader wants to point at (`gesture pinch`, `--udid`, `WARDEN_HOME`, a troubleshooting symptom)
 * is a table row. Every body row whose first cell opens with inline code or a **bold term** gets
 * an id from it, and that lead becomes a link to its own row, so `/docs/agents/ui#gesture-pinch`
 * lands on pinch. Bold is how a table of prose terms opts in; a data table (benchmarks, timings)
 * leads with plain text and stays unanchored. Wired into the MDX pipeline in `source.config.ts`;
 * `.row-anchor` and `tr:target` are styled in `app.css`.
 */

/** Tokens that end a command's name: an argument placeholder, an alternation, a call, a separator. */
const STOP = /^[[<{(|·'"`]/;
const WORD = /^-{0,2}([A-Za-z0-9_$@][\w$@.-]*)/;
/** A name past this many words is a sentence, not a command. */
const MAX_WORDS = 4;

/** A value a flag requires (`<n>`, `'x,y'`), as opposed to an optional `[ms]`. */
const REQUIRED_VALUE = /^[<'"]/;

/**
 * A row's id from its leading code: the command's words and flags up to its first placeholder
 * (`gesture pinch [target] <scale>` → `gesture-pinch`, `snapshot --settle [ms]` →
 * `snapshot-settle`, `screen.gesture.pinch({ … })` → `screen-gesture-pinch`). After a command, a
 * flag that takes a value is an option of it, not part of its name (`gesture path --path '…'`).
 */
export function rowSlug(code: string): string | undefined {
	const words: string[] = [];
	const tokens = code.trim().split(/\s+/);
	for (const [i, token] of tokens.entries()) {
		if (words.length === MAX_WORDS || STOP.test(token)) break;
		if (words.length > 0 && token.startsWith("-") && REQUIRED_VALUE.test(tokens[i + 1] ?? "")) break;
		const word = WORD.exec(token);
		if (!word) break;
		words.push(word[1]);
		if (word[0].length < token.length) break;
	}

	const slug = words
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || undefined;
}

/** A prose term's id is at most this many words: enough to tell symptoms apart, short enough to share. */
const MAX_TERM_WORDS = 6;

/** A row's id from its bold term: its words up to the first `;`, `:`, `(` or dash, lowercased. */
export function termSlug(term: string): string | undefined {
	const words = term
		.split(/[;:(—–]/)[0]
		.replace(/['’]/g, "")
		.trim()
		.split(/\s+/)
		.slice(0, MAX_TERM_WORDS);
	const slug = words
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || undefined;
}

function isElement(node: RootContent | ElementContent | Root): node is Element {
	return node.type === "element";
}

function textOf(node: ElementContent): string {
	if (node.type === "text") return node.value;
	return isElement(node) ? node.children.map(textOf).join("") : "";
}

function* elements(node: Root | Element): Generator<Element> {
	for (const child of node.children) {
		if (!isElement(child)) continue;
		yield child;
		yield* elements(child);
	}
}

const SLUGGERS: Record<string, (text: string) => string | undefined> = { code: rowSlug, strong: termSlug };

/** The cell's leading `code` or `strong` and the id it names, skipping whitespace; anything else first means prose. */
function leadingTerm(cell: Element): { node: Element; slug: string } | undefined {
	const first = cell.children.find((child) => child.type !== "text" || child.value.trim() !== "");
	if (!first || !isElement(first)) return undefined;
	const slug = SLUGGERS[first.tagName]?.(textOf(first));
	return slug ? { node: first, slug } : undefined;
}

const HEADINGS = new Set(["h2", "h3"]);

/** A free id for `slug`: itself, then under the section it sits in (`warden-claim-json`), then numbered. */
function freeId(slug: string, heading: string | undefined, taken: Set<string>): string {
	const candidates = [slug, heading && heading !== slug ? `${heading}-${slug}` : undefined];
	for (const id of candidates) if (id && !taken.has(id)) return id;

	let n = 2;
	while (taken.has(`${slug}-${n}`)) n++;
	return `${slug}-${n}`;
}

/** Give one body row its id and link its leading term to it; a row led by plain text is left alone. */
function anchorRow(row: ElementContent, heading: string | undefined, taken: Set<string>) {
	if (!isElement(row) || row.tagName !== "tr") return;
	const cell = row.children.find(isElement);
	const term = cell && leadingTerm(cell);
	if (!cell || !term) return;

	const id = freeId(term.slug, heading, taken);
	taken.add(id);
	row.properties.id = id;
	const link: Element = {
		type: "element",
		tagName: "a",
		properties: { href: `#${id}`, className: ["row-anchor"] },
		children: [term.node],
	};
	cell.children[cell.children.indexOf(term.node)] = link;
}

function idOf(node: Element): string | undefined {
	return typeof node.properties.id === "string" ? node.properties.id : undefined;
}

export function rehypeRowAnchors() {
	return (tree: Root) => {
		const taken = new Set([...elements(tree)].map(idOf).filter((id) => id !== undefined));

		let heading: string | undefined;
		for (const node of elements(tree)) {
			if (HEADINGS.has(node.tagName)) heading = idOf(node) ?? heading;
			if (node.tagName !== "tbody") continue;
			for (const row of node.children) anchorRow(row, heading, taken);
		}
	};
}
