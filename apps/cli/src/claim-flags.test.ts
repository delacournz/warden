import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { resolveOwner } from "@delacour/warden-leasing/owner";
import {
	DEVICECTL_LOCKSTATE_UNLOCKED,
	devicectlEntry,
	devicectlJson,
} from "@delacour/warden-providers/devicectl.fixtures";
import { claimWithFlags, parseClaimFlags, withNamedPhysical } from "./claim-flags";
import { fakeSimctl, OWNER_ENV } from "./simctl.testing";
import { type TestContext, testContext } from "./testing";

describe("parseClaimFlags", () => {
	test("defaults", () => {
		const result = parseClaimFlags("ios", {}, 16);
		expect(result).toEqual({
			success: true,
			data: {
				request: { platform: "ios", profile: "iphone-17", count: 1, max: 4 },
				waitMs: 30 * 60_000,
				ttlMs: DEFAULT_TTL_MS,
				maxDefaulted: true,
			},
		});
	});

	test("--no-wait is fail-fast; --wait overrides the 30m default", () => {
		const none = parseClaimFlags("ios", { wait: false });
		expect(none.success && none.data.waitMs).toBe(0);
		const some = parseClaimFlags("ios", { wait: "2m" });
		expect(some.success && some.data.waitMs).toBe(120_000);
	});

	test("--priority takes names or numbers; the command default is carried, bad input rejected", () => {
		const named = parseClaimFlags("ios", { priority: "high" });
		expect(named.success && named.data.priority).toBe(20);
		const numeric = parseClaimFlags("ios", { priority: "25" });
		expect(numeric.success && numeric.data.priority).toBe(25);
		const fallback = parseClaimFlags("ios", {}, 16, undefined, 0);
		expect(fallback.success && fallback.data.defaultPriority).toBe(0);
		expect(parseClaimFlags("ios", { priority: "urgent" }).success).toBe(false);
	});

	test("default ttl is overridable by the caller; --ttl still wins", () => {
		const short = parseClaimFlags("ios", {}, 16, BARE_CLAIM_AGENT_TTL_MS);
		expect(short.success && short.data.ttlMs).toBe(5 * 60_000);
		const explicit = parseClaimFlags("ios", { ttl: "1h" }, 16, BARE_CLAIM_AGENT_TTL_MS);
		expect(explicit.success && explicit.data.ttlMs).toBe(60 * 60_000);
	});

	test("all flags", () => {
		const result = parseClaimFlags(
			"android",
			{ profile: "pixel-9", runtime: "35", count: "2", max: "3", wait: "10m", ttl: "1h", label: "e2e", adopt: true },
			8
		);
		expect(result).toEqual({
			success: true,
			data: {
				request: { platform: "android", profile: "pixel-9", runtime: "35", count: 2, max: 3, adopt: true },
				waitMs: 600_000,
				ttlMs: 3_600_000,
				label: "e2e",
			},
		});
	});

	test("headless: set only when true", () => {
		const on = parseClaimFlags("ios", { headless: true }, 16);
		expect(on.success && on.data.headless).toBe(true);
		const off = parseClaimFlags("ios", { headless: false }, 16);
		expect(off.success && "headless" in off.data).toBe(false);
	});

	test("max defaults to at least count", () => {
		const result = parseClaimFlags("ios", { count: "3" }, 4);
		expect(result.success && result.data.request.max).toBe(3);
	});

	test("rejects bad input", () => {
		expect(parseClaimFlags(undefined, {}).success).toBe(false);
		expect(parseClaimFlags("windows", {}).success).toBe(false);
		expect(parseClaimFlags("ios", { count: "0" }).success).toBe(false);
		expect(parseClaimFlags("ios", { count: "x" }).success).toBe(false);
		expect(parseClaimFlags("ios", { wait: "soon" }).success).toBe(false);
	});
});

describe("parseClaimFlags physical", () => {
	const UDID = "00008140-001234567890001C";
	const ok = (platform: string, values: Parameters<typeof parseClaimFlags>[1]) => {
		const r = parseClaimFlags(platform, values, 16);
		if (!r.success) throw new Error(r.error);
		return r.data;
	};
	const fail = (platform: string, values: Parameters<typeof parseClaimFlags>[1]) => {
		const r = parseClaimFlags(platform, values, 16);
		return r.success ? undefined : r.error;
	};

	test("--physical asks for one physical device of the platform", () => {
		expect(ok("android", { physical: true }).request).toMatchObject({ platform: "android", count: 1, physical: {} });
		expect(ok("android", { physical: true }).request.adopt).toBeUndefined();
	});

	test("--serial (android) / --udid (ios) imply --physical, name the ids and set the count", () => {
		expect(ok("android", { physicalSerial: ["A1", "B2"] }).request).toMatchObject({
			count: 2,
			physical: { ids: ["A1", "B2"] },
		});
		expect(ok("ios", { physicalUdid: [UDID] }).request).toMatchObject({ count: 1, physical: { ids: [UDID] } });
	});

	test("--serial on ios, --udid on android and a simulator UUID in --udid are rejected", () => {
		expect(fail("ios", { physicalSerial: ["A1"] })).toContain("--serial is android-only");
		expect(fail("android", { physicalUdid: [UDID] })).toContain("--udid is ios-only");
		expect(fail("ios", { physicalUdid: ["5F1E9C37-2B7A-4C1D-9E0A-123456789ABC"] })).toContain(
			"not a physical iOS device id"
		);
	});

	test.each([
		["--count", { count: "2" }],
		["--max", { max: "3" }],
		["--slim", { slim: true }],
		["--headless", { headless: true }],
		["--runtime", { runtime: "35" }],
		["--adopt", { adopt: true }],
		["--biometrics", { biometrics: true }],
	] as const)("%s is rejected with --physical", (flag, extra) => {
		expect(fail("android", { physical: true, ...extra })).toContain(`${flag} cannot be used with --physical`);
	});

	test("--biometrics says why: a real sensor is never enrolled or matched", () => {
		expect(fail("ios", { physical: true, biometrics: true })).toContain("Face ID / fingerprint sensor");
	});

	test("--count 1, --no-slim and --no-headless are harmless with --physical", () => {
		expect(
			fail("android", { physical: true, count: "1", slim: false, headless: false, biometrics: false })
		).toBeUndefined();
	});

	test("a physical claim does not default max", () => {
		expect(ok("android", { physical: true }).maxDefaulted).toBeUndefined();
	});

	test("a plain claim is unchanged: no physical on the request", () => {
		expect(ok("android", {}).request.physical).toBeUndefined();
	});
});

describe("withNamedPhysical", () => {
	test("--serial / --udid become physicalSerial / physicalUdid; other values stay", () => {
		type Values = { physical?: boolean; serial?: string[]; udid?: string[]; count?: string };
		const named = (values: Values) => withNamedPhysical<Values>(values);
		expect(named({ physical: true, serial: ["S1"], count: "1" })).toEqual({
			physical: true,
			count: "1",
			physicalSerial: ["S1"],
		});
		expect(named({ udid: ["U1"] })).toEqual({ physicalUdid: ["U1"] });
		expect(named({ count: "2" })).toEqual({ count: "2" });
	});
});

describe("physical allowlist", () => {
	const A = "00008140-000A0B0C0D0E0F10";
	const B = "00008132-000A0B0C0D0E0F11";
	let actx: TestContext | undefined;
	afterEach(() => actx?.cleanup());

	/** two ready, connected iPads/iPhones; every id is made up */
	const make = (env: Record<string, string> = {}, config?: unknown): TestContext => {
		const list = devicectlJson(
			[A, B].map((udid, i) =>
				devicectlEntry({
					udid,
					name: `Test device ${i}`,
					deviceType: "iPhone",
					osVersion: "27.2",
					transportType: "wired",
				})
			)
		);
		const exec = fakeSimctl(
			[],
			[],
			[
				["xcrun devicectl list devices", { stdout: list }],
				["xcrun devicectl device info lockState", { stdout: DEVICECTL_LOCKSTATE_UNLOCKED }],
			]
		);
		actx = testContext([], { exec });
		actx.env = { ...actx.env, ...OWNER_ENV, ...env };
		if (config !== undefined) writeFileSync(join(actx.cwd, "warden.config.json"), JSON.stringify(config));
		return actx;
	};
	const claimIds = async (c: TestContext, values: Parameters<typeof parseClaimFlags>[1]): Promise<string[]> => {
		const flags = parseClaimFlags("ios", values, 16);
		if (!flags.success) throw new Error(flags.error);
		const outcome = await claimWithFlags(c, resolveOwner(c), flags.data, undefined, {});
		if (!outcome.success) throw new Error(outcome.error.message);
		return outcome.data.claimed.map((d) => d.device.id);
	};
	const failure = async (c: TestContext, values: Parameters<typeof parseClaimFlags>[1]): Promise<string> => {
		const flags = parseClaimFlags("ios", values, 16);
		if (!flags.success) throw new Error(flags.error);
		const outcome = await claimWithFlags(c, resolveOwner(c), { ...flags.data, waitMs: 0 }, undefined, {});
		return outcome.success ? "claimed" : outcome.error.message;
	};

	test("no list: any ready physical device", async () => {
		expect((await claimIds(make(), { physical: true })).length).toBe(1);
	});

	test("WARDEN_PHYSICAL_IDS limits an id-less claim", async () => {
		expect(await claimIds(make({ WARDEN_PHYSICAL_IDS: B }), { physical: true })).toEqual([B]);
	});

	test("config physical.allow limits it too, and the env wins over it", async () => {
		const config = {
			projects: [{ name: "app", root: ".", bundleId: { ios: "com.example.app" } }],
			physical: { allow: [A] },
		};
		expect(await claimIds(make({}, config), { physical: true })).toEqual([A]);
	});

	test("the env list wins over the config list", async () => {
		const config = {
			projects: [{ name: "app", root: ".", bundleId: { ios: "com.example.app" } }],
			physical: { allow: [A] },
		};
		expect(await claimIds(make({ WARDEN_PHYSICAL_IDS: B }, config), { physical: true })).toEqual([B]);
	});

	test("naming a device beats the list", async () => {
		expect(await claimIds(make({ WARDEN_PHYSICAL_IDS: A }), { physicalUdid: [B] })).toEqual([B]);
	});

	test("an allowlist with nothing connected on it waits and says why", async () => {
		expect(await failure(make({ WARDEN_PHYSICAL_IDS: "00008140-000A0B0C0D0E0FFF" }), { physical: true })).toContain(
			"allowlist"
		);
	});

	test("an unreadable config fails the claim instead of ignoring the list", async () => {
		const c = make();
		writeFileSync(join(c.cwd, "warden.config.json"), "{ not json");
		expect(await failure(c, { physical: true })).toContain("allowlist");
	});
});

describe("parseClaimFlags biometrics", () => {
	test("biometrics: true puts the +bio identity on the requested profile", () => {
		const flags = parseClaimFlags("android", { profile: "pixel-10", biometrics: true });
		expect(flags.success && flags.data.request.profile).toBe("pixel-10+bio");
	});

	test("unset or false leaves the profile alone, default profile included", () => {
		const plain = parseClaimFlags("ios", {});
		const off = parseClaimFlags("ios", { biometrics: false });
		expect(plain.success && off.success && plain.data.request.profile).toBe(
			off.success ? off.data.request.profile : ""
		);
		expect(plain.success && plain.data.request.profile.endsWith("+bio")).toBe(false);
	});
});
