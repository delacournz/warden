import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import type { EnsureOptions, PreparedApp } from "./commands/app";
import { sessionEnsureApp } from "./lease-session";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "ci", runId: "r1" };
const opts: EnsureOptions = { project: "/p", eas: false, build: false };
const prepared = { project: { root: "/p" }, hash: "H" } as unknown as PreparedApp;

describe("sessionEnsureApp", () => {
	test("warm() fingerprints once per platform; every device's ensure reuses it", async () => {
		ctx = testContext([]);
		const prepares: string[] = [];
		const installs: string[] = [];
		const gate = Promise.withResolvers<void>();
		const session = sessionEnsureApp({
			prepare: async (_ctx, _opts, platform) => {
				prepares.push(platform);
				await gate.promise;
				return { success: true, data: prepared };
			},
			install: async (_ctx, _owner, _platform, deviceId, _opts, app) => {
				installs.push(`${deviceId}:${app.hash}`);
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			},
		});
		session.warm(ctx, opts, "ios");
		session.warm(ctx, opts, "ios");
		expect(prepares).toEqual(["ios"]);
		const ensures = Promise.all([
			session.ensure(ctx, owner, "ios", "U1", opts),
			session.ensure(ctx, owner, "ios", "U2", opts),
		]);
		expect(installs).toEqual([]);
		gate.resolve();
		const results = await ensures;
		expect(results.every((r) => r.success)).toBe(true);
		expect(prepares).toEqual(["ios"]);
		expect(installs.sort()).toEqual(["U1:H", "U2:H"]);
	});

	test("a fingerprint that fails during warm() is what every ensure reports; nothing is installed", async () => {
		ctx = testContext([]);
		const installs: string[] = [];
		const session = sessionEnsureApp({
			prepare: async () => ({ success: false, error: "no fingerprint" }),
			install: async (_ctx, _owner, _platform, deviceId) => {
				installs.push(deviceId);
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			},
		});
		session.warm(ctx, opts, "android");
		const res = await session.ensure(ctx, owner, "android", "E1", opts);
		expect(res).toEqual({ success: false, error: "no fingerprint" });
		expect(installs).toEqual([]);
	});
});
