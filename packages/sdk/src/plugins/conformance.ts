/**
 * Public entry of `@delacour/warden-sdk/plugins/conformance`: the driver conformance suite, so a third-party driver
 * proves it keeps the `Driver` contract. Imports `bun:test`: call it from a `*.test.ts` file.
 *
 * ```ts
 * import { runDriverConformance } from "@delacour/warden-sdk/plugins/conformance";
 * runDriverConformance("my farm", () => openFarmDriver("device-1"), { appId: "com.example.app" });
 * ```
 */

import type { Driver, DriverResult, Snapshot } from "@delacour/warden-driver/driver.types";
import { type DriverConformanceOptions, driverConformance } from "@delacour/warden-driver/testing/conformance";

export type { DriverConformanceOptions };

/** Throws when `result` is not a well-formed `DriverResult`. */
export function expectResultShape<T>(result: Awaited<DriverResult<T>>): void {
	driverConformance.expectResultShape(result);
}

/** Asserts the flat/tree invariants of a snapshot. */
export function expectSnapshotInvariants(snapshot: Snapshot, platform: Driver["platform"]): void {
	driverConformance.expectSnapshotInvariants(snapshot, platform);
}

/** Registers the conformance cases of `make`. */
export function runDriverConformance(
	name: string,
	make: () => Promise<Driver>,
	options: DriverConformanceOptions = {}
): void {
	driverConformance.run(name, make, options);
}

export { type ProviderConformanceOptions, runProviderConformance } from "./provider-conformance";
