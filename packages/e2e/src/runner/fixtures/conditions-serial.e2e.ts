import { beforeAll, describe, test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const networks = (): string =>
	(fake.driver?.callsOf("network") ?? []).map((c) => (c.op.kind === "preset" ? c.op.preset : c.op.kind)).join(",");
const launches = (): number => fake.driver?.callsOf("app.launch").length ?? 0;

describe.serial("chain", () => {
	beforeAll(() => {
		log(`beforeAll nets=${networks()} launches=${launches()}`);
	});

	test("first changes the network", async ({ device }) => {
		log(`first nets=${networks()}`);
		await device.network.set("offline");
	});

	test("second starts from the baseline the first one's teardown put back", () => {
		log(`second nets=${networks()} launches=${launches()}`);
	});
});
