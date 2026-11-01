/**
 * Public entry of `@delacour/warden-sdk`: the one facade module of the package (every other module is imported by
 * path). It exports the client factory, the thrown error class and the contract types.
 *
 * ```ts
 * import { createWardenClient, isWardenError } from "@delacour/warden-sdk";
 * await using warden = createWardenClient({ label: "qa", lockPolicy: "wait" });
 * ```
 */
export { createWardenClient } from "./client";
export type { ClientSeams } from "./core";
export { isWardenError, WardenError } from "./errors";
export type * from "./perf.types";
export type * from "./sdk.types";
export type * from "./specs.types";
