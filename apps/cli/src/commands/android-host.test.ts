import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { el, failWith, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { connectRemoteDriver } from "@delacour/warden-e2e/driver/remote/remote-client";
import { ok, type Result } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { createAndroidHostCommand } from "./android-host";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const SERIAL = "emulator-5554";
const screen = snapshotOf([el("button", { id: "go", label: "Go" })], { platform: "android" });

async function waitFor<T>(read: () => T | undefined, ms = 2000): Promise<T> {
	const until = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > until) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

function run(open: () => Promise<Result<Driver, string>>, extra: string[] = []) {
	const c = testContext([]);
	ctx = c;
	const socket = join(c.cwd, "h.sock");
	c.argv.splice(0, c.argv.length, "--serial", SERIAL, "--socket", socket, ...extra);
	const done = createAndroidHostCommand({ openDriver: async () => open() }).run(c);
	return { c, socket, done };
}

describe("warden __android-host", () => {
	test("prints one ready line naming its socket, serves the driver, and exits 0 on shutdown", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android", id: SERIAL });
		const { c, socket, done } = run(async () => ok(driver));
		const line = await waitFor(() => c.stdout[0]);
		expect(JSON.parse(line)).toEqual({ event: "ready", socket, pid: process.pid });
		const client = await connectRemoteDriver({ socketPath: socket });
		if (!client.success) throw new Error(client.error.message);
		expect(await client.data.driver().tap({ x: 1, y: 2 })).toEqual({ success: true, data: undefined });
		expect((await client.data.request("shutdown")).success).toBe(true);
		await client.data.close();
		expect(await done).toBe(0);
		expect(driver.closed).toBe(true);
		expect(c.stdout).toHaveLength(1);
	});

	test("the driver it serves answers alertIn locally (Android alerts are in the snapshot)", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android", id: SERIAL });
		const { socket, done } = run(async () => ok(driver));
		await waitFor(() => (ctx?.stdout[0] !== undefined ? true : undefined));
		const client = await connectRemoteDriver({ socketPath: socket });
		if (!client.success) throw new Error(client.error.message);
		expect(client.data.ready.alertIn).toBe("android");
		await client.data.request("shutdown");
		await client.data.close();
		await done;
	});

	test("exits on its own after --idle-timeout with no client", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android", id: SERIAL });
		const { done } = run(async () => ok(driver), ["--idle-timeout", "0.05"]);
		expect(await done).toBe(0);
		expect(driver.closed).toBe(true);
	});

	test("a driver that cannot open exits 3 with the reason on stderr and prints no ready line", async () => {
		const { c, done } = run(async () => ({ success: false, error: "E_NOT_BOOTED: emulator-5554 is not booted" }));
		expect(await done).toBe(3);
		expect(c.stdout).toEqual([]);
		expect(c.stderr.join("\n")).toContain("E_NOT_BOOTED");
	});

	test("rejects a missing serial or socket, and a bad idle timeout", async () => {
		const driver = fakeDriver({ screens: [screen], onCall: () => failWith("E_INTERNAL") });
		const { done } = run(async () => ok(driver), ["--idle-timeout", "soon"]);
		expect(await done).toBe(1);
	});
});
