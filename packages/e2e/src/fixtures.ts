import { createApp } from "./app";
import { type AlertAction, createDevice, createSessionConditions, type Device } from "./device";
import { linkInFlight } from "./device-link";
import type { DevtoolsFacet } from "./devtools/devtools.types";
import { E2eError } from "./errors";
import type { BaseFixtures, FixtureContext } from "./runner/fixtures.types";
import type { ScreenHost } from "./screen/context";
import { createScreen } from "./screen/screen";
import { traceDevice } from "./traced-device";

/**
 * `device.alert(action)` for a read that answers sheets on the side: a sheet that stays up after every press
 * (`ACTION_FAILED`) is left for the read to go on with, not thrown out of an unrelated `isVisible()`.
 */
export async function answerAlertQuietly(device: Pick<Device, "alert">, action: AlertAction): Promise<boolean> {
	try {
		return await device.alert(action);
	} catch (error) {
		if (error instanceof E2eError && error.code === "ACTION_FAILED") return false;
		throw error;
	}
}

/**
 * What `screen` needs from one attempt: the live driver, its timeouts and deadline, and reported steps. With
 * `systemAlerts` set (`test.use`) and a `device` to press with, reads and waits answer the alerts they see.
 */
export function screenHostFor(ctx: FixtureContext, device?: Pick<Device, "alert">): ScreenHost {
	const { session } = ctx;
	const alerts = ctx.systemAlerts;
	const answerSystemAlert =
		device === undefined || alerts === undefined || alerts === "off"
			? undefined
			: async () => !linkInFlight(session) && (await answerAlertQuietly(device, alerts));
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
		span: (op, fn, options) => session.span(op, fn, options),
		...(answerSystemAlert === undefined ? {} : { answerSystemAlert }),
	};
}

/**
 * The `app` / `device` / `screen` / `platform` every test gets, over the session's driver. `device` calls and
 * locator reads are trace-only spans (`device.*`, `read.*`); the driver's own calls are `driver.*` spans (the session
 * traces its driver).
 */
export async function defaultFixtureFactory(ctx: FixtureContext): Promise<BaseFixtures> {
	const { session } = ctx;
	const driver = await session.driver();
	const conditions = createSessionConditions(session, driver, session.env);
	const device = traceDevice(createDevice({ session, driver, env: session.env, conditions }), session.span);
	return {
		app: createApp({ session, driver, env: session.env, injectWanted: conditions.internals.wantsInject }),
		device,
		screen: createScreen(screenHostFor(ctx, device)),
		platform: session.env.platform,
	};
}
