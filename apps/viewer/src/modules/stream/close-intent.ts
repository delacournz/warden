import type { Scope } from "../../core/api/device.api.ts";
import type { Overlay } from "./billing-state.ts";

type CloseContext = { detached: boolean; scope: Scope; overlay: Overlay | null };

/**
 * Whether closing the window asks "keep running or shut down": whenever the device is still up.
 * Attached, Shut down goes to the CLI (it stops the device and ends the lease); detached, the
 * viewer stops the device itself with its token, which only a `drive` token may do, so a detached
 * `view` window just closes.
 */
export function asksOnClose({ detached, scope, overlay }: CloseContext): boolean {
	if (overlay !== null) return false;
	return !detached || scope === "drive";
}
