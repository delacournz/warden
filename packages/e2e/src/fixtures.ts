import { createApp } from "./app";
import { createDevice } from "./device";
import type { BaseFixtures, FixtureContext } from "./runner/fixtures.types";
import type { ScreenHost } from "./screen/context";
import { createScreen } from "./screen/screen";

/** What `screen` needs from one attempt: the live driver, its timeouts and deadline, and reported steps. */
export function screenHostFor(ctx: FixtureContext): ScreenHost {
	const { session } = ctx;
	return {
		driver: () => session.driver(),
		env: { actionTimeoutMs: ctx.actionTimeoutMs, assertionTimeoutMs: ctx.assertionTimeoutMs },
		get signal() {
			return session.signal;
		},
		step: (label, fn) => session.step("locator", label, fn),
	};
}

/** The `app` / `device` / `screen` / `platform` every test gets, over the session's driver. */
export async function defaultFixtureFactory(ctx: FixtureContext): Promise<BaseFixtures> {
	const { session } = ctx;
	const driver = await session.driver();
	return {
		app: createApp({ session, driver, env: session.env }),
		device: createDevice({ session, driver, env: session.env }),
		screen: createScreen(screenHostFor(ctx)),
		platform: session.env.platform,
	};
}
