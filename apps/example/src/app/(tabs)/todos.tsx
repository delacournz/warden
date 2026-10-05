import { useState } from "react";
import { View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ListGroup } from "@/components/ui/list-group";
import { Screen } from "@/components/ui/screen";
import { Tabs } from "@/components/ui/tabs";
import { IconInboxEmpty, IconPlusSmall } from "@/lib/icons/central";
import { TodoRow } from "@/modules/todos/components/todo-row";
import { useTodos } from "@/modules/todos/contexts/todos.context";
import { filterTodos, remainingCount, type TodoFilter } from "@/modules/todos/utils/todos";

const FILTERS: readonly { value: TodoFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	{ value: "done", label: "Done" },
];

function isTodoFilter(value: string): value is TodoFilter {
	return FILTERS.some((f) => f.value === value);
}

/** The todo list: add box, filter tabs, rows and an empty state per filter. */
export default function Todos() {
	const { todos, add, toggle } = useTodos();
	const [draft, setDraft] = useState("");
	const [filter, setFilter] = useState<TodoFilter>("all");
	const remaining = remainingCount(todos);

	const submit = () => {
		add(draft);
		setDraft("");
	};

	return (
		<Screen testID="todos-screen">
			<Screen.Navbar
				actions={
					<Badge color={remaining ? "primary" : "success"} testID="todos-remaining" variant="soft">
						{`${remaining} left`}
					</Badge>
				}
				center={<Screen.Navbar.Title>Todos</Screen.Navbar.Title>}
				placement="static"
			/>
			<Screen.ScrollArea contentContainerClassName="gap-4 px-5" keyboardAware>
				<View className="flex-row gap-2">
					<Input
						className="flex-1"
						onChangeText={setDraft}
						onSubmitEditing={submit}
						placeholder="What needs doing?"
						returnKeyType="done"
						testID="todo-input"
						value={draft}
					/>
					<Button
						accessibilityLabel="Add todo"
						isDisabled={!draft.trim()}
						onPress={submit}
						size="icon-md"
						testID="todo-add"
					>
						<Icon icon={IconPlusSmall} />
					</Button>
				</View>
				<Tabs onValueChange={(v) => isTodoFilter(v) && setFilter(v)} value={filter}>
					<Tabs.List>
						<Tabs.Indicator />
						{FILTERS.map((f) => (
							<Tabs.Trigger key={f.value} testID={`todos-filter-${f.value}`} value={f.value}>
								{f.label}
							</Tabs.Trigger>
						))}
					</Tabs.List>
				</Tabs>
				<TodoList filter={filter} onToggle={toggle} todos={filterTodos(todos, filter)} />
			</Screen.ScrollArea>
		</Screen>
	);
}

type TodoListProps = {
	todos: ReturnType<typeof filterTodos>;
	filter: TodoFilter;
	onToggle: (id: string) => void;
};

/** Rows for the current filter, or an empty state naming it. */
function TodoList({ todos, filter, onToggle }: TodoListProps) {
	if (todos.length === 0) {
		return (
			<EmptyState size="sm" testID="todos-empty" variant="card">
				<EmptyState.Header>
					<EmptyState.Media variant="icon">
						<Icon icon={IconInboxEmpty} />
					</EmptyState.Media>
					<EmptyState.Title>{filter === "done" ? "Nothing done yet" : "Nothing to do"}</EmptyState.Title>
					<EmptyState.Description>Add a todo above to get going.</EmptyState.Description>
				</EmptyState.Header>
			</EmptyState>
		);
	}
	return (
		<ListGroup testID="todos-list">
			{todos.map((todo) => (
				<TodoRow key={todo.id} onToggle={onToggle} todo={todo} />
			))}
		</ListGroup>
	);
}
