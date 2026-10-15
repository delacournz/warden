/** Replaced at publish time (`Bun.build` `define`, see `apps/cli/src/npm/e2e-bundle.ts`) with warden's version. */
declare const __WARDEN_E2E_VERSION__: string | undefined;

/** What `WARDEN_E2E_VERSION` is when running from the workspace sources: not a published build, so no handshake. */
export const WORKSPACE_VERSION = "0.0.0-workspace";

/**
 * The version of this `@delacour/warden-e2e`. Published builds carry warden's own version (lock-step);
 * `warden e2e` hands its version to the spec process (`WARDEN_VERSION`) and the preload warns when they differ.
 */
export const WARDEN_E2E_VERSION: string =
	typeof __WARDEN_E2E_VERSION__ === "string" ? __WARDEN_E2E_VERSION__ : WORKSPACE_VERSION;
