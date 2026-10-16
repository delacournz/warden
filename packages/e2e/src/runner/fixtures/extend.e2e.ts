import { afterEach, test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

type Extra = { account: string; session: { account: string } };

const it = test.extend<Extra>({
	account: async (_base, use) => {
		log("account setup");
		await use("acct-1");
		log("account teardown");
	},
	session: async (base, use) => {
		log(`session setup for ${base.account}`);
		await use({ account: base.account });
		log("session teardown");
	},
});

afterEach(() => log("afterEach"));

it("uses fixtures and fails", async ({ account, session, platform }) => {
	log(`body ${account} ${session.account} ${platform}`);
	throw new Error("boom");
});

it("fixtures are set up again for the next test", async ({ account }) => {
	log(`second ${account}`);
});
