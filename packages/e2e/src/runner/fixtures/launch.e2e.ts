import { describe, test } from "../../index";
import { fake, fixtureLog } from "./fake-setup";

class LaunchProbe {
	launches(): string {
		const calls = fake.driver?.callsOf("app.launch") ?? [];
		return `launches=${calls.length} args=${JSON.stringify(calls.at(-1)?.opts?.args ?? [])}`;
	}
}

const probe = new LaunchProbe();

test("fresh is the default: the runner opens the app before the body", () =>
	fixtureLog.write(`default ${probe.launches()}`));

describe("none", () => {
	test.use({ launch: "none" });
	test("the body opens it itself", async ({ app }) => {
		fixtureLog.write(`before ${probe.launches()}`);
		await app.open({ args: ["--extra"] });
		fixtureLog.write(`after ${probe.launches()}`);
	});
});
