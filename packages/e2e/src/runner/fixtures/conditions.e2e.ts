import { test } from "../../index";
import { fake, fixtureLog } from "./fake-setup";

class ConditionProbe {
	networks(): string {
		return (fake.driver?.callsOf("network") ?? [])
			.map((c) => (c.op.kind === "preset" ? c.op.preset : c.op.kind))
			.join(",");
	}

	injected(): string {
		return String(fake.driver?.callsOf("app.launch").at(-1)?.opts?.inject ?? false);
	}
}

const probe = new ConditionProbe();

test("first changes the network and location and leaves a flap running", async ({ device }) => {
	fixtureLog.write(`first inject=${probe.injected()} nets=${probe.networks()}`);
	await device.network.set("offline");
	await device.network.flap({ up: "1h", down: "1h", base: "3g" });
	await device.location.set({ lat: 1, lon: 2 });
});

test("second starts from the suite baseline", async ({ device }) => {
	const status = await device.network.status();
	fixtureLog.write(`second inject=${probe.injected()} nets=${probe.networks()} flapping=${status.flapping}`);
	fixtureLog.write(`locations=${(fake.driver?.callsOf("location") ?? []).map((c) => c.op.kind).join(",")}`);
});
