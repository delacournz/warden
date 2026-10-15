import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { indexSnapshot, type NodeEntry } from "@delacour/warden-e2e/screen/nodes";
import { renderEntryLine } from "@delacour/warden-e2e/screen/render";

/** One element of a snapshot diff. `=` lines are counted, not listed (`unchanged`). */
export type DiffEntry = { kind: "+" | "-"; line: string; ref?: string };

export type SnapshotDiff = {
	added: DiffEntry[];
	removed: DiffEntry[];
	unchanged: number;
};

type Keyer = (entry: NodeEntry) => string | undefined;

/** The three identities an element can be matched by, strongest first: id → role+label → path. */
const KEYERS: readonly Keyer[] = [
	(entry) => {
		const id = entry.element.identifier;
		return id === undefined || id === "" ? undefined : `id:${id}`;
	},
	(entry) => (entry.name === undefined ? undefined : `rl:${entry.role}\u0000${entry.name}`),
	(entry) => `path:${entry.role}\u0000${entry.element.id}`,
];

function bucket(entries: readonly NodeEntry[], keyer: Keyer): Map<string, NodeEntry[]> {
	const groups = new Map<string, NodeEntry[]>();
	for (const entry of entries) {
		const key = keyer(entry);
		if (key === undefined) continue;
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	}
	return groups;
}

/** Pair up elements of `before` and `after`: each pass matches what the stronger passes left over, in document order. */
function matchEntries(before: readonly NodeEntry[], after: readonly NodeEntry[]): Map<NodeEntry, NodeEntry> {
	const pairs = new Map<NodeEntry, NodeEntry>();
	const matchedAfter = new Set<NodeEntry>();
	for (const keyer of KEYERS) {
		const left = before.filter((entry) => !pairs.has(entry));
		const right = after.filter((entry) => !matchedAfter.has(entry));
		const rightGroups = bucket(right, keyer);
		const used = new Map<string, number>();
		for (const entry of left) {
			const key = keyer(entry);
			if (key === undefined) continue;
			const position = used.get(key) ?? 0;
			const candidate = rightGroups.get(key)?.[position];
			if (candidate === undefined) continue;
			used.set(key, position + 1);
			pairs.set(entry, candidate);
			matchedAfter.add(candidate);
		}
	}
	return pairs;
}

/** An element's line without ref or indentation: equal lines = unchanged. */
function content(entry: NodeEntry): string {
	return renderEntryLine(entry);
}

/**
 * `+/-/=` between two snapshots of one screen. Elements are paired by identifier, then role+label,
 * then path; a pair whose rendered line changed (value, state, frame …) is one `-` and one `+`.
 * `refs` (element id → `@eN`) labels the `+` lines with their ref in the new snapshot.
 */
export function diffSnapshots(
	before: Snapshot,
	after: Snapshot,
	refs: ReadonlyMap<string, string> = new Map()
): SnapshotDiff {
	const a = indexSnapshot(before).entries;
	const b = indexSnapshot(after).entries;
	const pairs = matchEntries(a, b);
	const reverse = new Map([...pairs].map(([from, to]) => [to, from]));
	const removed: DiffEntry[] = [];
	const added: DiffEntry[] = [];
	let unchanged = 0;
	for (const entry of a) {
		const partner = pairs.get(entry);
		if (partner === undefined) removed.push({ kind: "-", line: content(entry) });
		else if (content(partner) === content(entry)) unchanged += 1;
		else removed.push({ kind: "-", line: content(entry) });
	}
	for (const entry of b) {
		const ref = refs.get(entry.element.id);
		const withRef = ref === undefined ? {} : { ref };
		const partner = reverse.get(entry);
		if (partner === undefined || content(partner) !== content(entry)) {
			added.push({ kind: "+", line: content(entry), ...withRef });
		}
	}
	return { added, removed, unchanged };
}

/** Text rendering: `-`/`+` lines (new lines carry their ref), then a `= N unchanged` summary. */
export function renderDiff(diff: SnapshotDiff): string[] {
	return [
		...diff.removed.map((entry) => `- ${entry.line}`),
		...diff.added.map((entry) => `+ ${entry.ref === undefined ? "" : `${entry.ref} `}${entry.line}`),
		`= ${diff.unchanged} unchanged`,
	];
}
