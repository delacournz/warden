import { afterEach, test } from "../../index";
import { fixtureLog } from "./fake-setup";

type Extra = { account: string; session: { account: string } };

const it = test.extend<Extra>({
	account: async (_base, use) => {
		fixtureLog.write("account setup");
		await use("acct-1");
		fixtureLog.write("account teardown");
	},
	session: async (base, use) => {
		fixtureLog.write(`session setup for ${base.account}`);
		await use({ account: base.account });
		fixtureLog.write("session teardown");
	},
});

afterEach(() => fixtureLog.write("afterEach"));

it("uses fixtures and fails", async ({ account, session, platform }) => {
	fixtureLog.write(`body ${account} ${session.account} ${platform}`);
	throw new Error("boom");
});

it("fixtures are set up again for the next test", async ({ account }) => {
	fixtureLog.write(`second ${account}`);
});
