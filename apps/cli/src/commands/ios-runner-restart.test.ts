import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { createIosRunnerRestartCommand } from "./ios-runner-restart";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "00008140-000A0B0C0D0E0F10";

describe("warden __ios-runner-restart", () => {
	test("stops the host, then starts a new one, in that order, for the udid", async () => {
		ctx = testContext(["--udid", UDID]);
		const events: string[] = [];
		const command = createIosRunnerRestartCommand({
			stop: async (_c, udid) => {
				events.push(`stop ${udid}`);
				return {};
			},
			ensure: async (_c, udid) => {
				events.push(`ensure ${udid}`);
				return { success: true };
			},
		});
		expect(await command.run(ctx)).toBe(0);
		expect(events).toEqual([`stop ${UDID}`, `ensure ${UDID}`]);
	});

	test("a host that does not come back exits 3 with the reason; --udid is required", async () => {
		ctx = testContext(["--udid", UDID]);
		const command = createIosRunnerRestartCommand({
			stop: async () => ({}),
			ensure: async () => ({ success: false, error: "device locked" }),
		});
		expect(await command.run(ctx)).toBe(3);
		expect(ctx.stderr.join("\n")).toContain("device locked");
		const bare = testContext([]);
		expect(await command.run(bare)).toBe(1);
		bare.cleanup();
	});
});
