import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLock } from "./deps";
import {
	comparePins,
	computePins,
	GUEST_LOCK_PATH,
	type GuestPins,
	interfaceHash,
	LIBRARIES_DIR,
	librariesPresent,
	NATIVE_DIR,
	parseGuestLock,
	parseVersionDisassembly,
	serializeGuestLock,
} from "./guest-pin";

const pins: GuestPins = {
	idbVersion: "v1.7.8",
	protocolVersion: 6,
	guestSha256: "a".repeat(64),
	interfaceSha256: "b".repeat(64),
};

const DISASSEMBLY = `SimulatorFrameworkBridge-iOS:
(__TEXT,__text) section
_$s25FBSimulatorBridgeProtocol0B7RequestV14currentVersionSivgZ:
000000010008f468\tmov\tw0, #0x6
000000010008f46c\tret
_$s25FBSimulatorBridgeProtocol0B8ResponseV7versionSivg:
000000010008f470\tldr\tx0, [x20]
000000010008f474\tret
`;

describe("parseVersionDisassembly", () => {
	test("reads the constant the getter returns", () => {
		expect(parseVersionDisassembly(DISASSEMBLY)).toEqual({ success: true, data: 6 });
		expect(parseVersionDisassembly(DISASSEMBLY.replace("#0x6", "#0x10"))).toEqual({ success: true, data: 16 });
		expect(parseVersionDisassembly(DISASSEMBLY.replace("#0x6", "#7"))).toEqual({ success: true, data: 7 });
	});

	test("does not read the next function's body", () => {
		const loads = DISASSEMBLY.replace("mov\tw0, #0x6", "ldr\tx0, [x9]").replace("ldr\tx0, [x20]", "mov\tw0, #0x9");
		expect(parseVersionDisassembly(loads).success).toBe(false);
	});

	test("fails clearly when the symbol is gone", () => {
		const res = parseVersionDisassembly("(__TEXT,__text) section\n");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("getter not found");
	});
});

describe("interfaceHash", () => {
	test("ignores the compiler-version comment header only", () => {
		const body = "public struct BridgeRequest {}\n";
		expect(interfaceHash(`// swift-compiler-version: 6.3.3\n${body}`)).toBe(
			interfaceHash(`// swift-compiler-version: 6.4\n${body}`)
		);
		expect(interfaceHash(`// x\n${body}`)).not.toBe(interfaceHash(`// x\n${body}public struct Added {}\n`));
	});
});

describe("comparePins", () => {
	test("equal pins pass", () => {
		expect(comparePins(pins, { ...pins })).toEqual({ ok: true });
	});

	test("a protocol bump names both versions and the replay", () => {
		const verdict = comparePins(pins, { ...pins, protocolVersion: 7, idbVersion: "v1.8.0" });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.message).toContain("idb guest protocol changed v6→v7");
			expect(verdict.message).toContain("guest-contract.ts --udid");
			expect(verdict.message).toContain("update the golden frames");
		}
	});

	test("an interface change at the same version, then a bare binary change, then a stale idb version", () => {
		const iface = comparePins(pins, { ...pins, interfaceSha256: "c".repeat(64) });
		expect(!iface.ok && iface.message).toContain("without a protocol bump");
		const binary = comparePins(pins, { ...pins, guestSha256: "d".repeat(64) });
		expect(!binary.ok && binary.message).toContain("guest binary changed");
		const stale = comparePins(pins, { ...pins, idbVersion: "v1.7.9" });
		expect(!stale.ok && stale.message).toContain("idb-guest.lock.json is for idb v1.7.8");
	});
});

describe("lock file", () => {
	test("round-trips and rejects a malformed pin", () => {
		expect(parseGuestLock(serializeGuestLock(pins))).toEqual(pins);
		expect(() => parseGuestLock(JSON.stringify({ ...pins, guestSha256: "xyz" }))).toThrow();
	});

	test("committed lock parses and names the idb release idb.lock.json pins", () => {
		const guest = parseGuestLock(readFileSync(GUEST_LOCK_PATH, "utf8"));
		const idb = parseLock(readFileSync(join(NATIVE_DIR, "idb.lock.json"), "utf8"));
		expect(guest.idbVersion).toBe(idb.version);
	});
});

/**
 * The guard itself: recompute the pins from the extracted libraries and hold them to the committed lock. Without
 * `idb-libraries` (tokenless or fresh clone: `bun run --cwd packages/e2e native:deps`) or without `otool` (no
 * Xcode tools, not macOS) it is skipped by name, never failed.
 */
const stamp = join(LIBRARIES_DIR, ".warden-idb.json");
const idbVersion = parseLock(readFileSync(join(NATIVE_DIR, "idb.lock.json"), "utf8")).version;
const installed: string | undefined = existsSync(stamp)
	? (JSON.parse(readFileSync(stamp, "utf8")) as { version?: string }).version
	: undefined;
const hasOtool = Bun.which("otool") !== null;
const skipReason = !librariesPresent()
	? "idb-libraries not extracted: run `bun run --cwd packages/e2e native:deps`"
	: installed !== idbVersion
		? `idb-libraries is ${installed ?? "unstamped"} but idb.lock.json pins ${idbVersion}: run native:deps`
		: !hasOtool
			? "otool not found (needs macOS + Xcode command line tools)"
			: undefined;

describe("idb guest pins against the extracted libraries", () => {
	if (skipReason) {
		test.skip(`SKIPPED, ${skipReason}`, () => {});
		return;
	}
	test("protocol version, interface and guest binary match idb-guest.lock.json", async () => {
		const actual = await computePins(idbVersion);
		if (!actual.success) throw new Error(actual.error);
		const verdict = comparePins(parseGuestLock(readFileSync(GUEST_LOCK_PATH, "utf8")), actual.data);
		if (!verdict.ok) throw new Error(verdict.message);
	});
});
