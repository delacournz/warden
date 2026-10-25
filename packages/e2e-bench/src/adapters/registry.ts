import type { BenchAdapter, FrameworkId } from "./adapter.types";
import { agentDeviceAdapter } from "./agent-device";
import { argentAdapter } from "./argent";
import { testerArmyAdapter } from "./tester-army";
import { wardenAdapter } from "./warden";

/** Every adapter, in `FRAMEWORK_IDS` order (the order the report lists them and the harness runs them). */
export const ADAPTERS: readonly BenchAdapter[] = [wardenAdapter, argentAdapter, agentDeviceAdapter, testerArmyAdapter];

export function adapterFor(id: FrameworkId): BenchAdapter | undefined {
	return ADAPTERS.find((a) => a.id === id);
}
