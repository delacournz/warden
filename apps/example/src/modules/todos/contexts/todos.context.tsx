import { createContext, type ReactNode, use, useMemo, useReducer, useRef } from "react";
import { SEED_TODOS, type Todo, todosReducer } from "../utils/todos";

type TodosContextValue = {
	todos: readonly Todo[];
	add: (title: string) => void;
	toggle: (id: string) => void;
	remove: (id: string) => void;
};

const TodosContext = createContext<TodosContextValue | null>(null);

/** In-memory todos seeded from `SEED_TODOS`; new ids are `todo-<n>` so tests can address them. */
export function TodosProvider({ children }: { children: ReactNode }) {
	const [todos, dispatch] = useReducer(todosReducer, SEED_TODOS);
	const nextId = useRef(1);
	const value = useMemo<TodosContextValue>(
		() => ({
			todos,
			add: (title) => {
				dispatch({ type: "add", id: `todo-${nextId.current}`, title });
				nextId.current += 1;
			},
			toggle: (id) => dispatch({ type: "toggle", id }),
			remove: (id) => dispatch({ type: "remove", id }),
		}),
		[todos]
	);
	return <TodosContext value={value}>{children}</TodosContext>;
}

export function useTodos(): TodosContextValue {
	const value = use(TodosContext);
	if (!value) throw new Error("useTodos must be used inside <TodosProvider>");
	return value;
}
