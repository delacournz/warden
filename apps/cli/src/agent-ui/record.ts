import type { Point } from "@delacour/warden-e2e/driver/driver.types";

/** The target of a recorded action, as `warden ui` resolved it. */
export type RecordTarget = { ref?: string; selector?: string; point: Point };

/** One action a `warden ui` subcommand performed, handed to the active flow recording (WDN-E2E-A9). */
export type RecordStep = {
	/** subcommand name: `press`, `fill`, `swipe`, `open`, … */
	action: string;
	target?: RecordTarget;
	/** the action's own arguments (`text`, `direction`, `bundleId`, …); secrets are left out, `secure: true` instead */
	args?: Record<string, string | number | boolean>;
};

/** Where finished actions are appended while a recording is active. A9 replaces the no-op default. */
export type RecordSink = {
	append: (udid: string, step: RecordStep) => Promise<void>;
};

export const noRecordSink: RecordSink = { append: async () => undefined };
