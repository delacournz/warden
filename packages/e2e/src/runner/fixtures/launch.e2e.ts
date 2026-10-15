import { describe, test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const launches = (): string => {
	const calls = fake.driver?.callsOf("app.launch") ?? [];
	return `launches=${calls.length} args=${JSON.stringify(calls.at(-1)?.opts?.args ?? [])}`;
};

test("fresh is the default: the runner opens the app before the body", () => log(`default ${launches()}`));

describe("none", () => {
	test.use({ launch: "none" });
	test("the body opens it itself", async ({ app }) => {
		log(`before ${launches()}`);
		await app.open({ args: ["--extra"] });
		log(`after ${launches()}`);
	});
});
