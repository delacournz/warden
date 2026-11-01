import type { PerfHostDeps } from "@delacour/warden-sdk/ops/perf/types";

export type { PerfHostDeps };

/** The real host facts live in the SDK (`ops/perf/host.ts`), loaded on first use so a cold start does not pay for them. */
export const defaultPerfHostDeps: PerfHostDeps = {
	platform: process.platform,
	metro: async (env, udid) => {
		const { defaultPerfHostDeps: real } = await import("@delacour/warden-sdk/ops/perf/host");
		return real.metro(env, udid);
	},
};
