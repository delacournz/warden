import { join } from "node:path";
import { type App, createApp } from "@delacour/warden-device/app";
import type { DeviceConditions } from "@delacour/warden-device/conditions/device-conditions";
import { type AlertAction, createDevice, createSessionConditions, type Device } from "@delacour/warden-device/device";
import type { DevtoolsSource } from "@delacour/warden-device/device-devtools";
import { linkInFlight } from "@delacour/warden-device/device-link";
import type { Clock, FixtureSession } from "@delacour/warden-device/fixture-session";
import type { PerfExec } from "@delacour/warden-device/perf/device-perf";
import { traceDevice } from "@delacour/warden-device/traced-device";
import type { DevtoolsFacet } from "@delacour/warden-devtools/devtools.types";
import type { Driver } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import type { ScreenHost } from "@delacour/warden-screen/context";
import { fieldEditor } from "@delacour/warden-screen/field";
import { screenFactory } from "@delacour/warden-screen/screen";
import type { E2eEnv } from "./env";
import type { BaseFixtures, FixtureContext } from "./runner/fixtures.types";

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
		env: {
			actionTimeoutMs: ctx.actionTimeoutMs,
			assertionTimeoutMs: ctx.assertionTimeoutMs,
			androidSetText: fieldEditor.setTextOptedIn(process.env),
		},
		get signal() {
			return session.signal;
		},
		step: (label, fn) => session.step("locator", label, fn),
		span: (op, fn, options) => session.span(op, fn, options),
		...(answerSystemAlert === undefined ? {} : { answerSystemAlert }),
	};
}

/** What the runner knows about one test: its session (deadline, trace, devtools, artifacts dir), env and driver. */
export type SessionFixtureInput = {
	session: FixtureSession;
	driver: Driver;
	env: Pick<E2eEnv, "bundleId" | "launchArgs" | "assertionTimeoutMs"> & Partial<E2eEnv>;
	clock?: Clock;
	/** runs `warden …` for `device.perf`; default spawns `WARDEN_BIN` */
	perfExec?: PerfExec;
	/** shared by `device` and `app` so a launch knows to load the network dylib; default: made here from the session */
	conditions?: DeviceConditions;
};

/**
 * `createDevice` over the runner's session and env: the one place they are turned into plain values. The attempt's
 * signal, artifacts dir and trace are read per call, since the runner swaps them for every attempt.
 */
export function deviceFor({ session, driver, env, clock, perfExec, conditions }: SessionFixtureInput): Device {
	const { devtools: attach, peekDevtools } = session;
	// the facet is attached on first access; without a Metro URL (release build) there is no devtools
	const devtools: DevtoolsSource | undefined =
		env.metroUrl === undefined || attach === undefined || peekDevtools === undefined
			? undefined
			: { devtools: () => attach.call(session), peekDevtools: () => peekDevtools.call(session) };
	return createDevice({
		driver,
		appId: env.bundleId,
		artifactsDir: () => session.attemptDir ?? join(session.out, "adhoc"),
		signal: () => session.signal,
		trace: () => session.trace,
		linkScope: session,
		conditions: conditions ?? createSessionConditions(session, driver, env),
		...(devtools === undefined ? {} : { devtools }),
		...(clock === undefined ? {} : { clock }),
		...(env.udid === undefined
			? {}
			: {
					perf: {
						udid: env.udid,
						wardenBin: env.wardenBin,
						budgets: env.perfBudgets,
						addFile: (relative: string) => session.attempt?.files.add(relative),
						...(perfExec === undefined ? {} : { exec: perfExec }),
					},
				}),
	});
}

/** `createApp` over the runner's session and env (see {@link deviceFor}). */
export function appFor({
	session,
	driver,
	env,
	clock,
	log,
	conditions,
	injectWanted = conditions?.internals.wantsInject,
}: SessionFixtureInput & { log?: (line: string) => void; injectWanted?: () => boolean }): App {
	return createApp({
		driver,
		appId: env.bundleId,
		launchArgs: env.launchArgs,
		assertionTimeoutMs: env.assertionTimeoutMs,
		signal: () => session.signal,
		...(injectWanted === undefined ? {} : { injectWanted }),
		// a dev client: attach devtools in the background, which keeps LogBox off in every JS context from now on
		onLaunched: () => {
			if (env.metroUrl !== undefined) void session.devtools?.();
		},
		...(env.appPath === undefined ? {} : { appPath: env.appPath }),
		...(clock === undefined ? {} : { clock }),
		...(log === undefined ? {} : { log }),
	});
}

/**
 * The `app` / `device` / `screen` / `platform` every test gets, over the session's driver. `device` calls and
 * locator reads are trace-only spans (`device.*`, `read.*`); the driver's own calls are `driver.*` spans (the session
 * traces its driver). `deviceFor` / `appFor` are the adapter from the runner to the runner-free `createDevice` /
 * `createApp`, which take plain values.
 */
export async function defaultFixtureFactory(ctx: FixtureContext): Promise<BaseFixtures> {
	const { session } = ctx;
	const driver = await session.driver();
	const conditions = createSessionConditions(session, driver, session.env);
	const device = traceDevice(deviceFor({ session, driver, env: session.env, conditions }), session.span);
	return {
		app: appFor({ session, driver, env: session.env, conditions }),
		device,
		screen: screenFactory.createScreen(screenHostFor(ctx, device)),
		platform: session.env.platform,
	};
}
