import type { Element, Snapshot } from "@delacour/warden-driver/driver.types";

/** The tree the `@eN` refs of `generation` point into. `takenAt` is `host.now()` ms. */
export type StoredSnapshot = {
	generation: number;
	takenAt: number;
	hash: string;
	snapshot: Snapshot;
};

/**
 * Where a device's ref generation and last snapshot live. `commit` takes the device's next generation number and
 * stores the snapshot under it in one step, so concurrent writers never share a generation and the stored snapshot
 * always carries the highest one. The SDK keeps it in memory; the CLI keeps it in `$WARDEN_HOME/ui/<udid>` so `@eN`
 * refs survive across processes (and go `stale_ref` when the generation moved on).
 */
export type RefStore = {
	/** the stored snapshot, if any */
	last: () => StoredSnapshot | undefined;
	/** take the next generation and store `entry` under it */
	commit: (entry: Omit<StoredSnapshot, "generation">) => StoredSnapshot;
};

/** In-process {@link RefStore}: generations count up from 1, nothing outlives the object. */
export function createMemoryRefStore(): RefStore {
	let generation = 0;
	let stored: StoredSnapshot | undefined;
	return {
		last: () => stored,
		commit: (entry) => {
			generation += 1;
			stored = { ...entry, generation };
			return stored;
		},
	};
}

/** Every element of a tree in document order (the `flat` list a stored snapshot is rebuilt with). */
export function preorder(elements: readonly Element[]): Element[] {
	return elements.flatMap((element) => [element, ...preorder(element.children)]);
}
