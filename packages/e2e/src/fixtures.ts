import { createApp } from "./app";
import { createDevice } from "./device";
import type { DevtoolsFacet } from "./devtools/devtools.types";
import type { BaseFixtures, FixtureContext } from "./runner/fixtures.types";
import type { ScreenHost } from "./screen/context";
import { createScreen } from "./screen/screen";

/** What `screen` needs from one attempt: the live driver, its timeouts and deadline, and reported steps. */
export function screenHostFor(ctx: FixtureContext): ScreenHost {
	const { session } = ctx;
	// the facet is attached on the first tree read; without a Metro URL (release build) there is nothing to read
	const reactTree: Pick<DevtoolsFacet, "tree"> | undefined =
		session.env.metroUrl === undefined
			? undefined
			: {
					async tree(options) {
						const attached = await session.devtools();
						return attached.success ? attached.data.tree(options) : attached;
					},
				};
	return {
		devtools: () => reactTree,
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
