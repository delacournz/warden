import type { Finding } from "../shared/findings.types";
import type { StartupStats } from "./stats";

export const SLOW_COLD_WARN_MS = 2000;
export const SLOW_COLD_CRITICAL_MS = 5000;

export type StartupMethod = "am-start" | "xctrace" | "simctl-approx";

/** `startup` findings carry `am-start | xctrace | approx`. */
const findingMethod = (method: StartupMethod): "am-start" | "xctrace" | "approx" =>
	method === "simctl-approx" ? "approx" : method;

/** Slow cold start: median over 2s warns, over 5s is critical. Nothing for a cold start that is fine. */
export function slowStartupFinding(
	method: StartupMethod,
	cold: StartupStats | undefined,
	rn: boolean
): Finding | undefined {
	if (cold === undefined || cold.medianMs <= SLOW_COLD_WARN_MS) return undefined;
	const approx = method === "simctl-approx" ? " (simctl wall time: a lower bound, time to process spawn)" : "";
	return {
		kind: "startup",
		severity: cold.medianMs > SLOW_COLD_CRITICAL_MS ? "critical" : "warn",
		costMs: cold.medianMs - SLOW_COLD_WARN_MS,
		evidence: `cold start median ${cold.medianMs}ms, p90 ${cold.p90Ms}ms over ${cold.runs} runs${approx}`,
		fix: rn
			? "defer work out of module scope and root render; check the JS bundle size and Hermes bytecode; profile with warden perf record --relaunch --js"
			: "move work off the main thread at launch; defer SDK init; check the launch trace for the longest period",
		next: ["warden perf record --relaunch --js", "warden perf startup --cold --runs 10"],
		method: findingMethod(method),
		runs: cold.runs,
	};
}
