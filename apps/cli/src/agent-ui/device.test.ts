import { afterEach, describe, expect, test } from "bun:test";
import { recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { Exec } from "@delacour/warden-core/exec";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { resolveUiDevice } from "./device";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

describe("resolveUiDevice --claim: leftover conditions", () => {
	test("taking over a stale lease undoes the conditions it left behind", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		ctx = testContext([], { exec, env: { WARDEN_HOME: "", WARDEN_SESSION_ID: "me" } });
		ctx.env.WARDEN_HOME = ctx.cwd;
		const stale = ctx.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: other, ttlMs: 1 },
			0
		);
		recordCondition(ctx.db, stale.id, "battery", { level: 5, charging: false, cosmetic: true }, 1);
		const device = await resolveUiDevice(ctx, { udid: UDID, claim: true }, { exclusive: false, pidAlive: () => false });
		expect(device.success && device.data.action).toBe("reclaimed");
		expect(calls).toContainEqual(["xcrun", "simctl", "status_bar", UDID, "clear"]);
		expect(ctx.db.db.query("SELECT COUNT(*) AS n FROM orphan_conditions").get()).toEqual({ n: 0 });
	});

	test("a plain lease-less call with nothing orphaned runs no resets", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			env: { WARDEN_SESSION_ID: "me" },
		});
		await resolveUiDevice(ctx, { udid: UDID, claim: true }, { exclusive: false, pidAlive: () => false });
		expect(calls).toEqual([]);
	});
});
