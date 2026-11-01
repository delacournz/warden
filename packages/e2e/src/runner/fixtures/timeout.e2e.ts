import { test } from "../../index";
import { sessions } from "../../session";
import { fixtureLog } from "./fake-setup";

test.use({ timeout: 300 });

test("a driver call that never answers", async () => {
	await sessions.get().step("driver", "tap id=sign-in", () => new Promise<void>(() => undefined));
});

test("a body that never settles", () => new Promise<void>(() => undefined));

test("the next test starts clean", async () => {
	const session = sessions.get();
	fixtureLog.write(`next depth=${session.attempt?.depth} aborted=${session.signal.aborted}`);
});
