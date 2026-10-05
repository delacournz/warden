import { router } from "expo-router";
import { Checkbox } from "@/components/ui/checkbox";
import { ListGroup } from "@/components/ui/list-group";
import type { Todo } from "../utils/todos";

type TodoRowProps = { todo: Todo; onToggle: (id: string) => void };

/** One todo: the checkbox toggles it, the rest of the row opens its detail screen. */
export function TodoRow({ todo, onToggle }: TodoRowProps) {
	return (
		<ListGroup.Item onPress={() => router.push(`/todo/${todo.id}`)} testID={`todo-row-${todo.id}`}>
			<ListGroup.ItemPrefix>
				<Checkbox
					accessibilityLabel={todo.title}
					isChecked={todo.done}
					onCheckedChange={() => onToggle(todo.id)}
					testID={`todo-check-${todo.id}`}
				/>
			</ListGroup.ItemPrefix>
			<ListGroup.ItemContent>
				<ListGroup.ItemTitle testID={`todo-title-${todo.id}`}>{todo.title}</ListGroup.ItemTitle>
				<ListGroup.ItemDescription>{todo.done ? "Done" : "Active"}</ListGroup.ItemDescription>
			</ListGroup.ItemContent>
			<ListGroup.ItemSuffix />
		</ListGroup.Item>
	);
}
