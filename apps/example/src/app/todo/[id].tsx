import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Screen } from "@/components/ui/screen";
import { useTodos } from "@/modules/todos/contexts/todos.context";

/** One todo, reachable from its row or `warden-example://todo/<id>`. Toggle or delete it here. */
export default function TodoDetail() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const { todos, toggle, remove } = useTodos();
	const todo = todos.find((t) => t.id === id);

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	const destroy = () => {
		if (!todo) return;
		remove(todo.id);
		back();
	};

	return (
		<Screen testID="todo-detail-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="todo-detail-back">
					<Screen.Navbar.Title>Todo</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.ScrollArea contentContainerClassName="gap-4 px-5">
				{todo ? (
					<Card>
						<Card.Header>
							<Card.Title testID="todo-detail-title">{todo.title}</Card.Title>
							<Card.Description>{`id: ${todo.id}`}</Card.Description>
							<Card.Action>
								<Chip color={todo.done ? "success" : "default"} testID="todo-detail-status">
									{todo.done ? "Done" : "Active"}
								</Chip>
							</Card.Action>
						</Card.Header>
						<Card.Footer>
							<Button onPress={() => toggle(todo.id)} size="sm" testID="todo-detail-toggle" variant="outline">
								{todo.done ? "Mark active" : "Mark done"}
							</Button>
							<Button onPress={destroy} size="sm" testID="todo-detail-delete" variant="destructive">
								Delete
							</Button>
						</Card.Footer>
					</Card>
				) : (
					<EmptyState size="sm" testID="todo-detail-missing" variant="card">
						<EmptyState.Header>
							<EmptyState.Title>Todo not found</EmptyState.Title>
							<EmptyState.Description>{`No todo with id "${id}".`}</EmptyState.Description>
						</EmptyState.Header>
					</EmptyState>
				)}
			</Screen.ScrollArea>
		</Screen>
	);
}
