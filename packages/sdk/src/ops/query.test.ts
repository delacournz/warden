import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-driver/testing/driver";
import { ok } from "@delacour/warden-types/result";
import { get, is, wait } from "./query";
import { createMemoryRefStore } from "./ref-store";
import type { OpSession } from "./session";
import { snapshot } from "./snapshot";
import { createMemoryStateStore } from "./state-store";

const SCREEN = snapshotOf([
	el("window", {
		children: [
			el("textfield", {
				label: "Email",
				id: "email",
				value: "a@b.co",
				frame: { x: 0, y: 100, width: 390, height: 44 },
			}),
			el("button", { label: "Cancel", id: "cancel", enabled: false }),
		],
	}),
]);

function session(): OpSession & { clock: { t: number } } {
	const clock = { t: 1_000 };
	const driver = fakeDriver({ screens: [SCREEN] });
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
		driver: async () => ok(driver),
		refs: createMemoryRefStore(),
		state: createMemoryStateStore(),
		timeoutMs: 300,
	};
}

describe("snapshot op", () => {
	test("each snapshot takes the next generation and stores it", async () => {
		const s = session();
		const first = await snapshot(s, { interactiveOnly: true });
		const second = await snapshot(s, {});
		expect(first.success && first.data.generation).toBe(1);
		expect(second.success && second.data.generation).toBe(2);
		expect(s.refs.last()?.generation).toBe(2);
	});
});

describe("wait op", () => {
	test("visible resolves with a fresh ref; a missing target times out as wait_target_absent", async () => {
		const s = session();
		const hit = await wait(s, { mode: "visible", selector: "id=email" });
		expect(hit.success && hit.data.result.matched).toBe(true);
		const miss = await wait(s, { mode: "visible", selector: "id=nope" });
		expect(!miss.success && miss.error.code).toBe("wait_target_absent");
		expect(!miss.success && miss.error.details?.reason).toBe("wait_target_absent");
	});

	test("absent on a visible element fails with wait_target_present", async () => {
		const miss = await wait(session(), { mode: "absent", selector: "id=email" });
		expect(!miss.success && miss.error.code).toBe("wait_target_present");
	});

	test("a bad selector is a usage error", async () => {
		const bad = await wait(session(), { mode: "visible", selector: "colour=red" });
		expect(!bad.success && bad.error.code).toBe("usage");
	});
});

describe("is / get ops", () => {
	test("is answers false with exit 1, also when nothing matches", async () => {
		const s = session();
		const no = await is(s, { selector: "id=cancel", state: "enabled" });
		expect(no.success && no.data.exit).toBe(1);
		const none = await is(s, { selector: "id=nope", state: "visible" });
		expect(none.success && none.data.result.reason).toBe("target_absent");
		const yes = await is(s, { selector: "id=email", state: "visible" });
		expect(yes.success && yes.data.exit).toBeUndefined();
	});

	test("get reads frame and count; a missing element is target_not_found", async () => {
		const s = session();
		const frame = await get(s, { selector: "id=email", property: "frame" });
		expect(frame.success && frame.data.text).toBe("0 100 390 44");
		const count = await get(s, { selector: "role=button", property: "count" });
		expect(count.success && count.data.result.value).toBe(1);
		const missing = await get(s, { selector: "id=nope", property: "text" });
		expect(!missing.success && missing.error.code).toBe("target_not_found");
	});
});
