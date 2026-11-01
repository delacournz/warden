import { describe, expect, test } from "bun:test";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { resultFactory } from "@delacour/warden-types/result";
import { fill, key, press, swipe } from "./actions";
import { path, pinch } from "./gestures";
import { createMemoryRefStore } from "./ref-store";
import { scroll } from "./scroll";
import type { OpSession } from "./session";
import { createMemoryStateStore } from "./state-store";

const SCREEN = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("textfield", {
				label: "Email",
				id: "email",
				value: "a@b.co",
				frame: { x: 0, y: 100, width: 390, height: 44 },
			}),
			driverFixtures.el("button", {
				label: "Sign in",
				id: "go",
				hittable: true,
				frame: { x: 0, y: 150, width: 390, height: 44 },
			}),
			driverFixtures.el("list", { id: "list", frame: { x: 20, y: 300, width: 350, height: 400 } }),
		],
	}),
]);

function session(driver: FakeDriver): { session: OpSession; clock: { t: number } } {
	const clock = { t: 1_000_000 };
	return {
		clock,
		session: {
			device: { id: "UDID", platform: "ios", name: "sim" },
			host: {
				env: {},
				cwd: "/tmp",
				home: "/tmp/warden-home",
				now: () => clock.t,
				exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
				sleep: async (ms) => {
					clock.t += ms;
				},
			},
			driver: async () => resultFactory.ok(driver),
			refs: createMemoryRefStore(),
			state: createMemoryStateStore(),
			timeoutMs: 5000,
		},
	};
}

describe("press", () => {
	test("by selector taps the element and reports the target", async () => {
		const driver = new FakeDriver({ screens: [SCREEN] });
		const { session: s } = session(driver);
		const done = await press(s, { target: "id=go" });
		expect(done.success).toBe(true);
		if (done.success) {
			expect(done.data.result).toMatchObject({ action: "press", target: { selector: "id=go" } });
			expect(done.data.text).toBe("pressed id=go");
		}
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("an @eN without a snapshot is stale_ref", async () => {
		const driver = new FakeDriver({ screens: [SCREEN] });
		const { session: s } = session(driver);
		const stale = await press(s, { target: "@e1" });
		expect(!stale.success && stale.error.code).toBe("stale_ref");
	});

	test("an empty target is a usage error", async () => {
		const { session: s } = session(new FakeDriver({ screens: [SCREEN] }));
		const done = await press(s, { target: "  " });
		expect(!done.success && done.error.code).toBe("usage");
	});
});

describe("fill and key", () => {
	test("fill without verify types and reports characters", async () => {
		const driver = new FakeDriver({ screens: [SCREEN] });
		const { session: s } = session(driver);
		const done = await fill(s, { target: "id=email", text: "x", verify: false });
		expect(done.success && done.data.result).toMatchObject({ action: "fill", characters: 1 });
	});

	test("fill via paste pastes on a driver that can, and only paste is recorded in the args", async () => {
		const driver = new FakeDriver({ screens: [SCREEN], pasteText: true });
		const { session: s } = session(driver);
		const steps: unknown[] = [];
		s.recorder = { append: async (_udid, step) => void steps.push(step) };
		const pasted = await fill(s, { target: "id=email", text: "x", verify: false, via: "paste" });
		expect(pasted.success).toBe(true);
		expect(driver.callsOf("pasteText")).toHaveLength(1);
		const typed = await fill(s, { target: "id=email", text: "y", verify: false });
		expect(typed.success).toBe(true);
		expect(driver.callsOf("pasteText")).toHaveLength(1);
		expect(steps[0]).toMatchObject({ args: { text: "x", via: "paste" } });
		expect(steps[1]).toMatchObject({ args: { text: "y" } });
		expect(steps[1]).not.toHaveProperty("args.via");
	});

	test("an unknown key is a usage error naming the choices", async () => {
		const { session: s } = session(new FakeDriver({ screens: [SCREEN] }));
		const done = await key(s, { key: "f13" });
		expect(!done.success && done.error.hint).toContain("Enter");
	});
});

describe("swipe and scroll", () => {
	test("swipe by direction works inside the screen", async () => {
		const driver = new FakeDriver({ screens: [SCREEN] });
		const { session: s } = session(driver);
		const done = await swipe(s, { direction: "up" });
		expect(done.success).toBe(true);
		expect(driver.callsOf("swipe")).toHaveLength(1);
	});

	test("scroll until a missing selector gives up with target_not_found after max swipes", async () => {
		const driver = new FakeDriver({ screens: [SCREEN] });
		const { session: s } = session(driver);
		const done = await scroll(s, { direction: "down", until: "id=far", max: 2 });
		expect(!done.success && done.error.code).toBe("target_not_found");
		expect(driver.callsOf("swipe")).toHaveLength(2);
	});
});

describe("gestures", () => {
	test("pinch on a driver without two-finger support names E_UNSUPPORTED", async () => {
		const driver = new FakeDriver({ screens: [SCREEN], capabilities: { pinch: false } });
		const { session: s } = session(driver);
		const done = await pinch(s, { scale: 2 });
		expect(!done.success && done.error.details).toMatchObject({ driver: "E_UNSUPPORTED", capability: "pinch" });
	});

	test("path rejects a single point", async () => {
		const { session: s } = session(new FakeDriver({ screens: [SCREEN] }));
		const done = await path(s, { paths: ["5,5"] });
		expect(!done.success && done.error.code).toBe("usage");
	});
});
