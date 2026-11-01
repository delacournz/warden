import { describe, expect, test } from "bun:test";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { resultFactory } from "@delacour/warden-types/result";
import { queryOps } from "./query";
import { refStores } from "./ref-store";
import type { OpSession } from "./session";
import { snapshotOps } from "./snapshot";
import { stateStores } from "./state-store";

const SCREEN = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("textfield", {
				label: "Email",
				id: "email",
				value: "a@b.co",
				frame: { x: 0, y: 100, width: 390, height: 44 },
			}),
			driverFixtures.el("button", { label: "Cancel", id: "cancel", enabled: false }),
		],
	}),
]);

function session(): OpSession & { clock: { t: number } } {
	const clock = { t: 1_000 };
	const driver = new FakeDriver({ screens: [SCREEN] });
	return {
		clock,
		device: { id: "UDID", platform: "ios" },
		host: {
			env: {},
			cwd: "/w",
			home: "/h",
			now: () => clock.t,
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			sleep: async (ms) => {
				clock.t += ms;
			},
		},
		driver: async () => resultFactory.ok(driver),
		refs: refStores.createMemoryRefStore(),
		state: stateStores.createMemoryStateStore(),
		timeoutMs: 300,
	};
}

describe("snapshot op", () => {
	test("each snapshot takes the next generation and stores it", async () => {
		const s = session();
		const first = await snapshotOps.snapshot(s, { interactiveOnly: true });
		const second = await snapshotOps.snapshot(s, {});
		expect(first.success && first.data.generation).toBe(1);
		expect(second.success && second.data.generation).toBe(2);
		expect(s.refs.last()?.generation).toBe(2);
	});
});

describe("wait op", () => {
	test("visible resolves with a fresh ref; a missing target times out as wait_target_absent", async () => {
		const s = session();
		const hit = await queryOps.wait(s, { mode: "visible", selector: "id=email" });
		expect(hit.success && hit.data.result.matched).toBe(true);
		const miss = await queryOps.wait(s, { mode: "visible", selector: "id=nope" });
		expect(!miss.success && miss.error.code).toBe("wait_target_absent");
		expect(!miss.success && miss.error.details?.reason).toBe("wait_target_absent");
	});

	test("absent on a visible element fails with wait_target_present", async () => {
		const miss = await queryOps.wait(session(), { mode: "absent", selector: "id=email" });
		expect(!miss.success && miss.error.code).toBe("wait_target_present");
	});

	test("a bad selector is a usage error", async () => {
		const bad = await queryOps.wait(session(), { mode: "visible", selector: "colour=red" });
		expect(!bad.success && bad.error.code).toBe("usage");
	});
});

describe("is / get ops", () => {
	test("is answers false with exit 1, also when nothing matches", async () => {
		const s = session();
		const no = await queryOps.is(s, { selector: "id=cancel", state: "enabled" });
		expect(no.success && no.data.exit).toBe(1);
		const none = await queryOps.is(s, { selector: "id=nope", state: "visible" });
		expect(none.success && none.data.result.reason).toBe("target_absent");
		const yes = await queryOps.is(s, { selector: "id=email", state: "visible" });
		expect(yes.success && yes.data.exit).toBeUndefined();
	});

	test("get reads frame and count; a missing element is target_not_found", async () => {
		const s = session();
		const frame = await queryOps.get(s, { selector: "id=email", property: "frame" });
		expect(frame.success && frame.data.text).toBe("0 100 390 44");
		const count = await queryOps.get(s, { selector: "role=button", property: "count" });
		expect(count.success && count.data.result.value).toBe(1);
		const missing = await queryOps.get(s, { selector: "id=nope", property: "text" });
		expect(!missing.success && missing.error.code).toBe("target_not_found");
	});
});
