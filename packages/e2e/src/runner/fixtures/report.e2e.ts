import { test } from "../../index";
import { getSession } from "../../session";

test.use({ launch: "none" });

test("steps", async () => {
	const session = getSession();
	await session.step("app", "app.open", async () => undefined);
	await session.step("locator", "tap id=sign-in", async () => {
		await session.step("driver", "snapshot", async () => undefined);
	});
});

test("fails in a step", async () => {
	await getSession().step("expect", "toBeVisible id=missing", async () => {
		throw new Error("not found");
	});
});
