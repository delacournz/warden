/** The most characters of JSON one tool reply carries. */
export const MAX_RESPONSE_CHARS = 60_000;

/** The most characters of any one string inside a reply (a console line, a response body, an evaluated value). */
export const MAX_STRING_CHARS = 4_000;

/** Which end of a list survives a cut: logs are newest-last (`last`), a component tree is read top-down (`first`). */
export type Keep = "first" | "last";

export type CapOptions = { keep: Keep; maxChars?: number; maxString?: number };

/**
 * `fits: false` = still over the limit with every list emptied; the caller answers an error instead.
 * `notes` say what was cut, one per kind of cut, for the notice beside the data.
 */
export type Capped = { fits: boolean; value: unknown; notes: string[] };

/** The name a root-level list gets in a note. */
const ROOT = "entries";

type Cut = { strings: number };

/** A copy of `value` with every string over `max` cut and marked. */
function cutStrings(value: unknown, max: number, cut: Cut): unknown {
	if (typeof value === "string") {
		if (value.length <= max) return value;
		cut.strings += 1;
		return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
	}
	if (Array.isArray(value)) return value.map((item) => cutStrings(item, max, cut));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, max, cut)]));
	}
	return value;
}

const jsonLength = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

type Holder = Record<string, unknown> | unknown[];

/** One list inside the value: where it hangs, so it can be swapped for a shorter one. */
type ListRef = { name: string; holder: Holder; key: string | number; list: unknown[]; depth: number; size: number };

/** Where a value hangs: the name its list gets in a note, what holds it, and how many lists enclose it. */
type Place = { name: string; holder: Holder; key: string | number; depth: number };

function collectLists(value: unknown, place: Place, into: ListRef[]): void {
	if (Array.isArray(value)) {
		if (value.length > 0) into.push({ ...place, list: value, size: jsonLength(value) });
		value.forEach((item, index) => {
			collectLists(item, { name: place.name, holder: value, key: index, depth: place.depth + 1 }, into);
		});
		return;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const [key, item] of Object.entries(record)) {
			collectLists(item, { name: key, holder: record, key, depth: place.depth }, into);
		}
	}
}

/**
 * The list to shorten next. A list encloses the lists inside it, so the largest is always the outermost: cutting it
 * can drop a whole element for the sake of one long list inside. So of the lists able to shed `excess` alone, the
 * innermost is cut (the largest, between equals); when none can, the largest overall.
 */
function pickList(lists: readonly ListRef[], excess: number): ListRef | undefined {
	const bySize = (a: ListRef, b: ListRef): number => b.size - a.size;
	const enough = lists.filter((ref) => ref.size >= excess);
	if (enough.length === 0) return [...lists].sort(bySize)[0];
	return enough.sort((a, b) => b.depth - a.depth || bySize(a, b))[0];
}

/** How many elements to drop from the `keep`-opposite end of `list` to shed `excess` characters (all, if it must). */
function dropCount(list: readonly unknown[], excess: number, keep: Keep): number {
	let shed = 0;
	let dropped = 0;
	while (dropped < list.length && shed < excess) {
		const index = keep === "last" ? dropped : list.length - 1 - dropped;
		shed += jsonLength(list[index]) + 1;
		dropped += 1;
	}
	return dropped;
}

/** Swap `ref`'s list for one `excess` characters shorter, and write (or update) its note. `lengths` remembers how long each list was before its first cut. */
function shorten(ref: ListRef, excess: number, keep: Keep, lengths: Map<unknown[], number>, notes: string[]): void {
	const drop = dropCount(ref.list, excess, keep);
	const kept = keep === "last" ? ref.list.slice(drop) : ref.list.slice(0, ref.list.length - drop);
	const original = lengths.get(ref.list) ?? ref.list.length;
	lengths.delete(ref.list);
	lengths.set(kept, original);
	(ref.holder as Record<string | number, unknown>)[ref.key] = kept;
	const note = `${ref.name}: the ${keep} ${kept.length} of ${original} kept`;
	const stale = notes.findIndex((n) => n.startsWith(`${ref.name}: `) && n.endsWith(` of ${original} kept`));
	if (stale >= 0) notes[stale] = note;
	else notes.push(note);
}

/** A result that reports its own `truncated` flag (the component tree) says so once a list of it was shortened. */
function markTruncated(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (record.truncated === false) record.truncated = true;
}

/**
 * Bound a tool's data without changing its shape. Data within the limit is returned untouched. Over it, long strings
 * are cut in place, then lists (`pickList`) lose elements from the end `keep` does not name until the JSON fits. Keys, scalars and the nesting stay, so the reply still parses
 * as the tool's result.
 */
export function capValue(value: unknown, options: CapOptions): Capped {
	const maxChars = options.maxChars ?? MAX_RESPONSE_CHARS;
	const maxString = options.maxString ?? MAX_STRING_CHARS;
	if (jsonLength(value) <= maxChars) return { fits: true, value, notes: [] };
	const cut: Cut = { strings: 0 };
	const root: { value: unknown } = { value: cutStrings(value, maxString, cut) };
	const notes: string[] = [];
	if (cut.strings > 0) notes.push(`${cut.strings} string${cut.strings === 1 ? "" : "s"} cut at ${maxString} chars`);

	const lengths = new Map<unknown[], number>();
	for (;;) {
		const excess = jsonLength(root.value) - maxChars;
		if (excess <= 0) break;
		const lists: ListRef[] = [];
		collectLists(root.value, { name: ROOT, holder: root as Record<string, unknown>, key: "value", depth: 0 }, lists);
		const next = pickList(lists, excess);
		if (next === undefined) return { fits: false, value: root.value, notes };
		shorten(next, excess, options.keep, lengths, notes);
	}
	if (lengths.size > 0) markTruncated(root.value);
	return { fits: true, value: root.value, notes };
}
