export type Todo = { id: string; title: string; done: boolean };

export type TodoFilter = "all" | "active" | "done";

export type TodosAction =
	| { type: "add"; id: string; title: string }
	| { type: "toggle"; id: string }
	| { type: "remove"; id: string };

/** Seeded on every launch, so tests and deep links (`warden-example://todo/warden`) can rely on them. */
export const SEED_TODOS: readonly Todo[] = [
	{ id: "welcome", title: "Explore the example app", done: false },
	{ id: "warden", title: "Run the e2e suite with warden", done: true },
];

export function todosReducer(todos: readonly Todo[], action: TodosAction): readonly Todo[] {
	switch (action.type) {
		case "add": {
			const title = action.title.trim();
			if (!title) return todos;
			return [...todos, { id: action.id, title, done: false }];
		}
		case "toggle":
			return todos.map((todo) => (todo.id === action.id ? { ...todo, done: !todo.done } : todo));
		case "remove":
			return todos.filter((todo) => todo.id !== action.id);
	}
}

export function filterTodos(todos: readonly Todo[], filter: TodoFilter): readonly Todo[] {
	if (filter === "all") return todos;
	return todos.filter((todo) => (filter === "done" ? todo.done : !todo.done));
}

export function remainingCount(todos: readonly Todo[]): number {
	return todos.filter((todo) => !todo.done).length;
}
