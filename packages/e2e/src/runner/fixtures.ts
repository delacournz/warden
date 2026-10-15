import { createApp } from "../app";
import { createDevice } from "../device";
import type { ScreenHost } from "../screen/context";
import { createScreen } from "../screen/screen";
import type { FixtureContext, FixtureFactory } from "./fixtures.types";

/**
 * What `screen` needs from one attempt. `signal` is read live (the session swaps it per attempt);
 * every locator action is reported as a `locator` step in the trace and on the console.
 */
export function screenHost(ctx: FixtureContext): ScreenHost {
	const { session } = ctx;
	return {
		driver: () => session.driver(),
		env: { actionTimeoutMs: ctx.actionTimeoutMs },
		actionTimeout: () => ctx.actionTimeoutMs,
		get signal() {
			return session.signal;
		},
		step: (label, fn) => session.step("locator", label, fn),
	};
}

/** The real `{ app, device, screen, platform }` over the session's driver. Registered by the preload. */
export const defaultFixtureFactory: FixtureFactory = async (ctx) => {
	const { session } = ctx;
	const driver = await session.driver();
	return {
		app: createApp({ session, driver, env: session.env }),
		device: createDevice({ session, driver, env: session.env }),
		screen: createScreen(screenHost(ctx)),
		platform: session.env.platform,
	};
};
