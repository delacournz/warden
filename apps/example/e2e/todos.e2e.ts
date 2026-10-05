import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";
import { signedIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("add, complete and filter todos", async ({ app, device, screen }) => {
	await signedIn(app, device, screen);

	await screen.getByTestId(ids.todos.input).fill("Write e2e flows");
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Write e2e flows");
	await expect(screen.getByTestId(ids.todos.remaining)).toContainText("2 left");

	await screen.getByTestId(ids.todos.check("todo-1")).tap();
	await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked();
	await expect(screen.getByTestId(ids.todos.remaining)).toContainText("1 left");

	await screen.getByTestId(ids.todos.filter("active")).tap();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeHidden();

	await screen.getByTestId(ids.todos.check("welcome")).tap();
	await expect(screen.getByTestId(ids.todos.empty)).toBeVisible();

	await screen.getByTestId(ids.todos.filter("done")).tap();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeVisible();
	await expect(screen.getByTestId(ids.todos.remaining)).toContainText("0 left");
});
