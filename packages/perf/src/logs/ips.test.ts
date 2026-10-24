import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appFrameAddresses, formatFrame, ipsMatches, parseIps, parseIpsTimestamp } from "./ips";

const read = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const shop = read("ips-shopapp-sim1.ips");
const SIM1 = "11111111-2222-3333-4444-555555555555";

function crash(text: string) {
	const parsed = parseIps(text);
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
}

describe("parseIps", () => {
	test("summarises exception, thread and frames", () => {
		const c = crash(shop);
		expect(c).toMatchObject({
			appName: "ShopApp",
			bundleId: "com.acme.shop",
			pid: 4321,
			exceptionType: "EXC_BAD_ACCESS",
			signal: "SIGSEGV",
			subtype: "KERN_INVALID_ADDRESS at 0x0000000000000010",
			termination: "Segmentation fault: 11",
			crashedThread: "com.facebook.react.JavaScript",
			incidentId: "A1B2C3D4-0000-4E5F-8A9B-112233445566",
		});
		expect(c.atMs).toBe(Date.parse("2026-10-24T10:02:11.00+13:00"));
		expect(c.frames.length).toBe(10);
		expect(formatFrame(c.frames[0] as never)).toBe("objc_msgSend +44 (libobjc.A.dylib)");
	});

	test("first app frame skips system images", () => {
		const f = crash(shop).firstAppFrame;
		expect(f).toMatchObject({ image: "ShopApp", imageOffset: 4521772, app: true });
		expect(f ? formatFrame(f) : "").toBe("ShopApp +4521772");
	});

	test("garbage is an error", () => {
		expect(parseIps("hello").success).toBe(false);
		expect(parseIps("{}\nnot json").success).toBe(false);
	});
});

describe("ipsMatches", () => {
	const c = crash(shop);
	test("bundle and simulator", () => {
		expect(ipsMatches(c, shop, { bundleId: "com.acme.shop", udid: SIM1 })).toBe(true);
		expect(ipsMatches(c, shop, { bundleId: "com.acme.shop", udid: "99999999-8888-7777-6666-555555555555" })).toBe(
			false
		);
		expect(ipsMatches(c, shop, { bundleId: "com.acme.other" })).toBe(false);
	});
	test("udid compares case-insensitively", () => {
		expect(ipsMatches(c, shop, { bundleId: "com.acme.shop", udid: SIM1.toLowerCase() })).toBe(true);
	});
	test("executable name matches when the bundle id differs", () => {
		expect(ipsMatches(c, shop, { bundleId: "x", executable: "ShopApp" })).toBe(true);
	});
	test("since", () => {
		expect(ipsMatches(c, shop, { bundleId: "com.acme.shop", sinceMs: (c.atMs ?? 0) + 1 })).toBe(false);
		expect(ipsMatches(c, shop, { bundleId: "com.acme.shop", sinceMs: (c.atMs ?? 0) - 1 })).toBe(true);
	});
});

test("parseIpsTimestamp honours the zone offset", () => {
	expect(parseIpsTimestamp("2026-10-24 10:02:11.00 +1300")).toBe(Date.UTC(2026, 9, 23, 21, 2, 11));
	expect(parseIpsTimestamp("nope")).toBeUndefined();
});

test("appFrameAddresses lists load-relative addresses of app images", () => {
	const addrs = appFrameAddresses(shop);
	expect(addrs[0]).toEqual({
		uuid: "5f6a1c2e-8b3d-4e7a-9c10-2d4b6f8a0e13",
		arch: "arm64",
		base: 4294967296,
		address: 4294967296 + 4521772,
	});
	expect(addrs.some((a) => a.uuid.startsWith("babe"))).toBe(true);
});
