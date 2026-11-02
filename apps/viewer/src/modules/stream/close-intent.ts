import type { Overlay } from "./billing-state.ts";

/**
 * Whether closing the window asks "keep running or shut down". Only an attached viewer can end the lease (the CLI
 * behind it holds the account token), and only a device that is still up has anything to keep running.
 */
export function asksOnClose(detached: boolean, overlay: Overlay | null): boolean {
	return !detached && overlay === null;
}
