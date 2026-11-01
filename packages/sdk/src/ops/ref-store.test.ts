import { describe, expect, test } from "bun:test";
import { snapshotHash } from "@delacour/warden-driver/settle";
import { el, snapshotOf } from "@delacour/warden-driver/testing/driver";
import { createMemoryRefStore, preorder } from "./ref-store";
import { createMemoryStateStore } from "./state-store";

const screen = () => snapshotOf([el("button", { label: "Go", id: "go" })]);

describe("createMemoryRefStore", () => {
	test("starts empty; commit takes generations 1, 2, 3 and keeps only the latest snapshot", () => {
		const store = createMemoryRefStore();
		expect(store.last()).toBeUndefined();
		const first = store.commit({ takenAt: 10, hash: "a", snapshot: screen() });
		const second = store.commit({ takenAt: 20, hash: "b", snapshot: screen() });
		expect([first.generation, second.generation]).toEqual([1, 2]);
		expect(store.last()).toBe(second);
		expect(store.last()?.takenAt).toBe(20);
	});

	test("two stores count independently (one per device)", () => {
		const a = createMemoryRefStore();
		const b = createMemoryRefStore();
		a.commit({ takenAt: 1, hash: snapshotHash(screen()), snapshot: screen() });
		expect(b.commit({ takenAt: 1, hash: "x", snapshot: screen() }).generation).toBe(1);
	});
});

describe("preorder", () => {
	test("lists parents before children, in document order", () => {
		const tree = snapshotOf([el("window", { children: [el("button", { label: "A" }), el("text", { label: "B" })] })]);
		expect(preorder(tree.elements).map((e) => e.label ?? e.rawType)).toHaveLength(3);
		expect(preorder(tree.elements)[0]?.children).toHaveLength(2);
	});
});

describe("createMemoryStateStore", () => {
	test("update replaces the state; returning the same object changes nothing", () => {
		const store = createMemoryStateStore();
		expect(store.read()).toEqual({});
		store.update((state) => ({ ...state, app: "com.x" }));
		expect(store.read()).toEqual({ app: "com.x" });
		const same = store.read();
		store.update((state) => state);
		expect(store.read()).toBe(same);
		store.update(() => ({}));
		expect(store.read()).toEqual({});
	});
});
