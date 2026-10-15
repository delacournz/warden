import { appendFileSync, writeFileSync } from "node:fs";
import { createApp } from "../../app";
import { createDevice } from "../../device";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "../../driver/driver.testing";
import { screenHostFor } from "../../fixtures";
import { createScreen } from "../../screen/screen";
import { setDefaultDriverFactory, setDefaultFixtureFactory } from "../../session";

/** Appends one line to `$FIXTURE_LOG` (the runner test reads it back to assert ordering). */
export function fixtureLog(line: string): void {
	const path = process.env.FIXTURE_LOG;
	if (path !== undefined && path !== "") appendFileSync(path, `${line}\n`);
}

/** The fake device of this process, for specs that assert on driver calls. */
export const fake: { driver: FakeDriver | undefined } = { driver: undefined };

setDefaultDriverFactory(async (env) => {
	fake.driver = fakeDriver({
		platform: env.platform,
		id: env.udid,
		screens: [snapshotOf([el("button", { label: "Sign in", id: "sign-in" }), el("text", { label: "Welcome" })])],
		onCall(call) {
			if (call.method === "screenshot" && call.opts?.path !== undefined) writeFileSync(call.opts.path, "PNG");
			return undefined;
		},
	});
	return { success: true, data: fake.driver };
});

setDefaultFixtureFactory(async (ctx) => {
	const { session } = ctx;
	const driver = await session.driver();
	if (process.env.FIXTURE_LOG_CTX === "1") {
		fixtureLog(`ctx ${ctx.launch} action=${ctx.actionTimeoutMs} assertion=${ctx.assertionTimeoutMs}`);
	}
	return {
		app: createApp({ session, driver, env: session.env }),
		device: createDevice({ session, driver, env: session.env }),
		screen: createScreen(screenHostFor(ctx)),
		platform: session.env.platform,
	};
});
