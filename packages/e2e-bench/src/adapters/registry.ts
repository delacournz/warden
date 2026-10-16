import type { BenchAdapter, FrameworkId } from "./adapter.types";
import { agentDeviceAdapter } from "./agent-device";
import { argentAdapter } from "./argent";
import { detoxAdapter } from "./detox";
import { maestroAdapter } from "./maestro";
import { testerArmyAdapter } from "./tester-army";
import { wardenAdapter } from "./warden";

/** Every adapter, in `FRAMEWORK_IDS` order (the order the report lists them and the harness runs them). */
export const ADAPTERS: readonly BenchAdapter[] = [
	wardenAdapter,
	maestroAdapter,
	argentAdapter,
	agentDeviceAdapter,
	testerArmyAdapter,
	detoxAdapter,
];

export function adapterFor(id: FrameworkId): BenchAdapter | undefined {
	return ADAPTERS.find((a) => a.id === id);
}
