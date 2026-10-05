import { describe, expect, test } from "bun:test";
import { filterTodos, remainingCount, SEED_TODOS, type Todo, todosReducer } from "./todos";

const base: Todo[] = [
	{ id: "a", title: "Buy milk", done: false },
	{ id: "b", title: "Walk dog", done: true },
];

describe("todosReducer", () => {
	test("add appends a trimmed todo with the given id", () => {
		const next = todosReducer(base, { type: "add", id: "c", title: "  Ship it  " });
		expect(next.at(-1)).toEqual({ id: "c", title: "Ship it", done: false });
	});

	test("add ignores a blank title", () => {
		expect(todosReducer(base, { type: "add", id: "c", title: "   " })).toBe(base);
	});

	test("toggle flips done for one id only", () => {
		const next = todosReducer(base, { type: "toggle", id: "a" });
		expect(next.map((t) => t.done)).toEqual([true, true]);
	});

	test("remove drops the todo", () => {
		expect(todosReducer(base, { type: "remove", id: "a" }).map((t) => t.id)).toEqual(["b"]);
	});
});

describe("filterTodos", () => {
	test("all / active / done", () => {
		expect(filterTodos(base, "all")).toHaveLength(2);
		expect(filterTodos(base, "active").map((t) => t.id)).toEqual(["a"]);
		expect(filterTodos(base, "done").map((t) => t.id)).toEqual(["b"]);
	});
});

test("remainingCount counts undone todos", () => {
	expect(remainingCount(base)).toBe(1);
});

test("seed todos have stable ids for deep links and e2e", () => {
	expect(SEED_TODOS.map((t) => t.id)).toEqual(["welcome", "warden"]);
});
