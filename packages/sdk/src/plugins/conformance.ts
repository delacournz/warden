/**
 * Public entry of `@delacour/warden-sdk/plugins/conformance`: the driver conformance suite, so a third-party driver
 * proves it keeps the `Driver` contract. Imports `bun:test`: call it from a `*.test.ts` file.
 *
 * ```ts
 * import { runDriverConformance } from "@delacour/warden-sdk/plugins/conformance";
 * runDriverConformance("my farm", () => openFarmDriver("device-1"), { appId: "com.example.app" });
 * ```
 */
export {
	type DriverConformanceOptions,
	expectResultShape,
	expectSnapshotInvariants,
	runDriverConformance,
} from "@delacour/warden-driver/testing/conformance";

export { type ProviderConformanceOptions, runProviderConformance } from "./provider-conformance";
