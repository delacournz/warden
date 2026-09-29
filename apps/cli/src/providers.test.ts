import { afterEach, describe, expect, test } from "bun:test";
import { fakeHost } from "@warden/core/golden/golden.testing";
import { providerFor } from "./providers";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner = { kind: "agent", sessionId: "me", cwd: "/" } as const;

describe("providerFor ios", () => {
	test("new sims are cloned from the golden by default", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		ctx = testContext([], { exec: host.exec });
		const created = await providerFor("ios", ctx, owner, { sleep: async () => {} }).create(
			"warden-iphone-17-1",
			"iphone-17"
		);
		expect(created.success && created.data.id).toMatch(/^CLONE-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(true);
	});

	test("WARDEN_GOLDEN=0 → plain simctl create", async () => {
		const host = fakeHost();
		ctx = testContext([], { exec: host.exec });
		ctx.env = { ...ctx.env, WARDEN_GOLDEN: "0" };
		const created = await providerFor("ios", ctx, owner).create("warden-iphone-17-1", "iphone-17");
		expect(created.success && created.data.id).toMatch(/^NEW-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(false);
	});
});
