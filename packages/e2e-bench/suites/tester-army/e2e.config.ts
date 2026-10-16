import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

/**
 * tester.army suite of the bench: the example app's 8 parity tests, locator-only (no `agent.act` /
 * `agent.assert`, so no model key and no LLM). The bench adapter picks the device through `BENCH_UDID` /
 * `BENCH_PLATFORM` and runs `e2e run` from this directory; one worker, no retries, like every other
 * framework in the bench. The session is named after the device so parallel benches never share one.
 * Run by hand: `BENCH_UDID=<udid> BENCH_PLATFORM=ios bunx e2e run` (Node 22.22.3+ / 24.8+).
 */
const platform = process.env.BENCH_PLATFORM === "android" ? "android" : "ios";
const device = process.env.BENCH_UDID;

export default {
	tests: ["*.e2e.ts"],
	targets: [
		{
			name: platform,
			engine: mobile({
				platform,
				...(device ? { device, session: `bench-${device}` } : {}),
			}),
			app: { bundleId: "nz.co.delacour.warden.example" },
		},
	],
	workers: 1,
	retries: 0,
	reporters: ["list", "json", "junit"],
} satisfies E2EConfig;
