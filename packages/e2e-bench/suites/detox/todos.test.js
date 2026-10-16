const { expect } = require("detox");
const { byId, signedIn } = require("./helpers/flows");
const { ids } = require("./helpers/ids");

describe("todos", () => {
	it("add, complete and filter todos", async () => {
		await signedIn();
		const remaining = byId(ids.todos.remaining);

		await byId(ids.todos.input).replaceText("Write e2e flows");
		await byId(ids.todos.add).tap();
		await expect(byId(ids.todos.title("todo-1"))).toHaveText("Write e2e flows");
		await expect(remaining).toHaveText("2 left");

		await byId(ids.todos.check("todo-1")).tap();
		await expect(byId(ids.todos.check("todo-1"))).toHaveToggleValue(true);
		await expect(remaining).toHaveText("1 left");

		await byId(ids.todos.filter("active")).tap();
		await expect(byId(ids.todos.row("welcome"))).toBeVisible();
		await expect(byId(ids.todos.row("todo-1"))).not.toExist();

		await byId(ids.todos.check("welcome")).tap();
		await expect(byId(ids.todos.empty)).toBeVisible();

		await byId(ids.todos.filter("done")).tap();
		await expect(byId(ids.todos.row("todo-1"))).toBeVisible();
		await expect(remaining).toHaveText("0 left");
	});
});
