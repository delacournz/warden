/**
 * What a cached build is for:
 * - `dev`: Debug, JS from Metro at runtime.
 * - `simulator`: Release for a simulator / emulator with no JS bundle embedded; a repack supplies the JS.
 * - `release`: Release with the JS bundle embedded at build time (the key also covers the JS sources).
 */
export type BuildKind = "dev" | "simulator" | "release";

export const BUILD_KINDS = ["dev", "simulator", "release"] as const satisfies readonly BuildKind[];
