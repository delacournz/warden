import { test } from "../../index";
import { getSession } from "../../session";
import { fixtureLog as log } from "./fake-setup";

test.use({ timeout: 300 });

test("a driver call that never answers", async () => {
	await getSession().step("driver", "tap id=sign-in", () => new Promise<void>(() => undefined));
});

test("a body that never settles", () => new Promise<void>(() => undefined));

test("the next test starts clean", async () => {
	const session = getSession();
	log(`next depth=${session.attempt?.depth} aborted=${session.signal.aborted}`);
});
