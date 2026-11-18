import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConditionArea, DEFAULT_KEYBOARD_MODE } from "./conditions.types";

/**
 * The state file an iOS app launched with `libwarden-inject.dylib` watches (offline flag, wall-clock offset /
 * freeze). The e2e driver owns the full format (`packages/e2e/src/driver/ios/inject.ts`); core only knows where it
 * lives and how to put it back to neutral on release, so a still-running injected app stops seeing the lease's
 * offline or shifted clock.
 */
export function injectStatePath(wardenHome: string, udid: string): string {
	return join(wardenHome, "inject", udid, "state.json");
}

/**
 * Write `{ seq: previous + 1, offline: false, clockOffsetMs: 0, camera: {} }` (no freeze, no camera feeds) when a state file exists; the dylib
 * applies any higher `seq`. `keyboard` and `passkeys` (the virtual authenticator) stay what the file had, except when
 * `area` is that area: `keyboard` goes back to the default, `passkeys` is dropped (authenticator off). The Keychain ACL
 * shim (`keychainAcl`) is always switched off, keeping its generation and sidecar path. No file = no
 * injected app was ever launched on the device: nothing to do.
 * Returns an error message, or undefined.
 */
export function neutralizeInjectState(path: string, area?: ConditionArea): string | undefined {
	if (!existsSync(path)) return undefined;
	let seq = 0;
	let keyboard: string | undefined;
	let passkeys: unknown;
	let keychainAcl: Record<string, unknown> | undefined;
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data === "object" && data !== null && "seq" in data && typeof data.seq === "number") seq = data.seq;
		if (typeof data === "object" && data !== null && "keyboard" in data && typeof data.keyboard === "string") {
			keyboard = data.keyboard;
		}
		if (typeof data === "object" && data !== null && "passkeys" in data) passkeys = data.passkeys;
		if (typeof data === "object" && data !== null && "keychainAcl" in data) {
			const value: unknown = data.keychainAcl;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) keychainAcl = { ...value };
		}
	} catch {
		// unreadable: start over from 0, the dylib applies the next seq it has not seen
	}
	try {
		const tmp = `${path}.${process.pid}.tmp`;
		const mode = area === "keyboard" ? DEFAULT_KEYBOARD_MODE : keyboard;
		const authenticator = area === "passkeys" ? undefined : passkeys;
		writeFileSync(
			tmp,
			JSON.stringify({
				seq: seq + 1,
				offline: false,
				clockOffsetMs: 0,
				camera: {},
				...(mode ? { keyboard: mode } : {}),
				...(authenticator !== undefined ? { passkeys: authenticator } : {}),
				// the Keychain ACL shim is per lease: off for a still-running app; generation and sidecar describe the sim
				...(keychainAcl ? { keychainAcl: { ...keychainAcl, enabled: false } } : {}),
			})
		);
		renameSync(tmp, path);
		return undefined;
	} catch (error) {
		return `reset ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * The Keychain ACL shim is per lease, and `warden ui open --keychain-acl` / `warden dev --keychain-acl` switch it on
 * without a condition record, so every release of an iOS device lease calls this (not only `neutralizeInjectState`'s
 * condition undo): an `enabled: true` switch goes off with a higher `seq` (a still-running app turns its gate off,
 * the next lease launches plain), everything else in the file kept. Nothing to do: no file, unreadable, never on.
 * Returns an error message, or undefined.
 */
export function switchOffKeychainAcl(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	let data: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		data = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const acl = data.keychainAcl;
	if (typeof acl !== "object" || acl === null || Array.isArray(acl) || !("enabled" in acl) || acl.enabled !== true) {
		return undefined;
	}
	const seq = typeof data.seq === "number" ? data.seq : 0;
	try {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...data, seq: seq + 1, keychainAcl: { ...acl, enabled: false } }));
		renameSync(tmp, path);
		return undefined;
	} catch (error) {
		return `switch the Keychain ACL shim off in ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
