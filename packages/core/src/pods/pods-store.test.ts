import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PodsHarness, podsHarness } from "./pods.testing";
import type { PodsEntry } from "./pods.types";
import { insertPodsEntry, listPodsEntries, podsEntryDir, prunePods, removePodsEntry } from "./pods-store";

let h: PodsHarness;
beforeEach(() => {
	h = podsHarness();
});
afterEach(() => {
	h.store.close();
	rmSync(h.dir, { recursive: true, force: true });
});

function add(key: string, lastUsedAt: number, sizeBytes = 100): PodsEntry {
	const entry: PodsEntry = {
		key,
		mode: "cng",
		root: "/r",
		projectRel: ".",
		sizeBytes,
		createdAt: 1,
		lastUsedAt,
		podVersion: "1",
		xcodeVersion: "x",
	};
	mkdirSync(podsEntryDir(h.deps.env, key), { recursive: true });
	writeFileSync(join(podsEntryDir(h.deps.env, key), "f"), "x");
	insertPodsEntry(h.store, entry);
	return entry;
}

describe("pods store", () => {
	test("list is most recently used first; remove deletes row and dir", () => {
		add("a", 10);
		add("b", 30);
		add("c", 20);
		expect(listPodsEntries(h.store).map((e) => e.key)).toEqual(["b", "c", "a"]);
		const removed = removePodsEntry(h.store, h.deps.env, "c");
		expect(removed.success).toBe(true);
		expect(existsSync(podsEntryDir(h.deps.env, "c"))).toBe(false);
		expect(listPodsEntries(h.store).map((e) => e.key)).toEqual(["b", "a"]);
		expect(removePodsEntry(h.store, h.deps.env, "c").success).toBe(false);
	});

	test("prune by age evicts the stale, oldest first", () => {
		add("old", 100);
		add("mid", 900);
		add("new", 1_000);
		const gone = prunePods(h.store, h.deps.env, { now: 1_000, olderThanMs: 500 });
		expect(gone.map((e) => e.key)).toEqual(["old"]);
		expect(
			listPodsEntries(h.store)
				.map((e) => e.key)
				.sort()
		).toEqual(["mid", "new"]);
	});

	test("prune to a byte budget is LRU and skips live keys", () => {
		add("a", 10, 100);
		add("b", 20, 100);
		add("c", 30, 100);
		const gone = prunePods(h.store, h.deps.env, { now: 99, maxBytes: 150, live: new Set(["a"]) });
		expect(gone.map((e) => e.key)).toEqual(["b", "c"]);
		expect(listPodsEntries(h.store).map((e) => e.key)).toEqual(["a"]);
		expect(existsSync(podsEntryDir(h.deps.env, "b"))).toBe(false);
	});

	test("dry run reports without deleting", () => {
		add("a", 10);
		add("b", 20);
		const gone = prunePods(h.store, h.deps.env, { now: 99, maxBytes: 0, dryRun: true });
		expect(gone.map((e) => e.key)).toEqual(["a", "b"]);
		expect(listPodsEntries(h.store)).toHaveLength(2);
		expect(existsSync(podsEntryDir(h.deps.env, "a"))).toBe(true);
	});
});
