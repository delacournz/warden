#!/usr/bin/env bun
/**
 * Pins of idb's in-simulator AX guest (`SimulatorFrameworkBridge-iOS`), kept in `native/idb-guest.lock.json` next
 * to `idb.lock.json`: the wire protocol version, the guest binary's sha256 and a hash of the protocol module's
 * public interface. `guest-pin.test.ts` recomputes them from the extracted `idb-libraries` and fails when an idb
 * bump moves any of them, so a protocol change surfaces in `bun test` instead of on a user's machine.
 *
 * `bun native/scripts/guest-pin.ts` prints the computed pins; `--write` rewrites the lock after the live replay
 * (`guest-contract.ts`) passed on the new guest.
 *
 * Where the version comes from: `BridgeRequest.currentVersion` is a `static let` whose value is in no header, in
 * the swiftinterface or in the ABI json. The guest binary exports its getter, which is a single `mov w0, #N; ret`:
 * that is the very number the guest checks incoming frames against (and answers `unsupportedVersion(N-1)` to), so
 * it cannot drift from what runs. The interface hash is the second line of defence for a change of wire shape that
 * forgot to bump the version.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { sha256OfFile } from "./deps";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");

const guestLockSchema = z.object({
	/** The idb release these pins were taken from; must equal `idb.lock.json` `version`. */
	idbVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
	protocolVersion: z.number().int().positive(),
	guestSha256: hex64,
	interfaceSha256: hex64,
});

export type GuestPins = z.infer<typeof guestLockSchema>;

export const NATIVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GUEST_LOCK_PATH = join(NATIVE_DIR, "idb-guest.lock.json");
export const LIBRARIES_DIR = join(NATIVE_DIR, "idb-libraries");
export const GUEST_RELATIVE = join("Resources", "SimulatorFrameworkBridge-iOS");
const INTERFACE_RELATIVE = join(
	"FBSimulatorBridgeProtocol.xcframework",
	"macos-arm64",
	"FBSimulatorBridgeProtocol.swiftmodule",
	"arm64-apple-macos.swiftinterface"
);
const VERSION_GETTER = "_$s25FBSimulatorBridgeProtocol0B7RequestV14currentVersionSivgZ";

export function parseGuestLock(text: string): GuestPins {
	return guestLockSchema.parse(JSON.parse(text));
}

export function serializeGuestLock(pins: GuestPins): string {
	return `${JSON.stringify(pins, null, "\t")}\n`;
}

/** The immediate in `mov w0, #0xN` that precedes `ret` in `otool -tV -p <getter>` output. */
export function parseVersionDisassembly(text: string): Result<number> {
	const lines = text.split("\n").map((line) => line.trim());
	const start = lines.indexOf(`${VERSION_GETTER}:`);
	if (start < 0) return err("currentVersion getter not found in the guest binary");
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^_\S+:$/.test(line)) break;
		body.push(line);
	}
	const mov = body.map((line) => /\bmov\s+w0,\s*#(0x[0-9a-f]+|\d+)\b/i.exec(line)).find((match) => match !== null);
	const next = body.findIndex((line) => /\bret\b/.test(line));
	if (!mov || next < 0)
		return err("currentVersion getter is not a constant return; the version has to be read another way");
	return ok(Number(mov[1]));
}

/** The module interface without its compiler-version comment header, so a different Xcode does not change it. */
export function interfaceHash(text: string): string {
	const body = text
		.split("\n")
		.filter((line) => !line.startsWith("//"))
		.join("\n");
	return createHash("sha256").update(body).digest("hex");
}

export function librariesPresent(dir: string = LIBRARIES_DIR): boolean {
	return existsSync(join(dir, GUEST_RELATIVE)) && existsSync(join(dir, INTERFACE_RELATIVE));
}

export async function computePins(
	idbVersion: string,
	dir: string = LIBRARIES_DIR,
	exec: Exec = bunExec
): Promise<Result<GuestPins>> {
	const guest = join(dir, GUEST_RELATIVE);
	const cmd = ["otool", "-tV", "-p", VERSION_GETTER, guest] as const;
	const res = await exec(cmd, { timeoutMs: 30_000 });
	if (res.exitCode !== 0) return err(execError(cmd, res));
	const version = parseVersionDisassembly(res.stdout);
	if (!version.success) return version;
	return ok({
		idbVersion,
		protocolVersion: version.data,
		guestSha256: await sha256OfFile(guest),
		interfaceSha256: interfaceHash(readFileSync(join(dir, INTERFACE_RELATIVE), "utf8")),
	});
}

/** Which pin moved first: protocol version, wire interface, guest binary, or only the idb release named in the lock. */
export type PinMove = "protocol" | "interface" | "guest" | "idb";

export type PinVerdict = { ok: true } | { ok: false; moved: PinMove; message: string };

const REPLAY = "bun native/scripts/guest-contract.ts --udid <udid>";

/** Compares computed pins to the committed ones, naming the first thing that moved and what to do about it. */
export function comparePins(committed: GuestPins, actual: GuestPins): PinVerdict {
	if (committed.protocolVersion !== actual.protocolVersion)
		return {
			ok: false,
			moved: "protocol",
			message: `idb guest protocol changed v${committed.protocolVersion}→v${actual.protocolVersion} (idb ${committed.idbVersion}→${actual.idbVersion}): re-run the guest contract replay (\`${REPLAY}\`), update the golden frames in native/scripts/fixtures/guest-v${actual.protocolVersion}, then \`bun native/scripts/guest-pin.ts --write\``,
		};
	if (committed.interfaceSha256 !== actual.interfaceSha256)
		return {
			ok: false,
			moved: "interface",
			message: `idb guest wire interface changed without a protocol bump (v${actual.protocolVersion}, idb ${actual.idbVersion}): re-run the guest contract replay (\`${REPLAY}\`), update the golden frames, then \`bun native/scripts/guest-pin.ts --write\``,
		};
	if (committed.guestSha256 !== actual.guestSha256)
		return {
			ok: false,
			moved: "guest",
			message: `idb guest binary changed (sha256 ${committed.guestSha256.slice(0, 12)}→${actual.guestSha256.slice(0, 12)}, idb ${committed.idbVersion}→${actual.idbVersion}) with protocol v${actual.protocolVersion} unchanged: re-run the guest contract replay (\`${REPLAY}\`), then \`bun native/scripts/guest-pin.ts --write\``,
		};
	if (committed.idbVersion !== actual.idbVersion)
		return {
			ok: false,
			moved: "idb",
			message: `idb-guest.lock.json is for idb ${committed.idbVersion}, libraries are ${actual.idbVersion}: \`bun native/scripts/guest-pin.ts --write\``,
		};
	return { ok: true };
}

if (import.meta.main) {
	const stampPath = join(LIBRARIES_DIR, ".warden-idb.json");
	const lock = JSON.parse(readFileSync(join(NATIVE_DIR, "idb.lock.json"), "utf8")) as { version: string };
	if (!librariesPresent() || !existsSync(stampPath)) {
		console.error("idb-libraries is not extracted: bun run --cwd packages/e2e native:deps");
		process.exit(2);
	}
	const pins = await computePins(lock.version);
	if (!pins.success) {
		console.error(pins.error);
		process.exit(1);
	}
	if (process.argv.includes("--write")) {
		writeFileSync(GUEST_LOCK_PATH, serializeGuestLock(pins.data));
		console.log(`wrote ${GUEST_LOCK_PATH}`);
	}
	console.log(serializeGuestLock(pins.data).trimEnd());
}
