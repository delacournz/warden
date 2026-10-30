import { test } from "../../index";
import { fake, fixtureLog as log } from "./fake-setup";

const networks = (): string =>
	(fake.driver?.callsOf("network") ?? []).map((c) => (c.op.kind === "preset" ? c.op.preset : c.op.kind)).join(",");
const injected = (): string => String(fake.driver?.callsOf("app.launch").at(-1)?.opts?.inject ?? false);

test("first changes the network and location and leaves a flap running", async ({ device }) => {
	log(`first inject=${injected()} nets=${networks()}`);
	await device.network.set("offline");
	await device.network.flap({ up: "1h", down: "1h", base: "3g" });
	await device.location.set({ lat: 1, lon: 2 });
});

test("second starts from the suite baseline", async ({ device }) => {
	const status = await device.network.status();
	log(`second inject=${injected()} nets=${networks()} flapping=${status.flapping}`);
	log(`locations=${(fake.driver?.callsOf("location") ?? []).map((c) => c.op.kind).join(",")}`);
});
