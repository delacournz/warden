import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where a device's virtual-authenticator credentials live, and how release deletes them. Kept apart from
 * `passkey-store.ts` (zod schema, key handling) so `undo.ts`, which every lease release loads, stays light.
 */
export function passkeyStorePath(wardenHome: string, deviceId: string): string {
	return join(wardenHome, "passkeys", deviceId, "store.json");
}

/** Delete the device's store directory; an error message, or undefined (also when there was none). */
export function removePasskeyStore(path: string): string | undefined {
	try {
		rmSync(dirname(path), { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return `remove passkey store ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
