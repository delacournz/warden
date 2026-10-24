import { appendFileSync, writeFileSync } from "node:fs";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "../../driver/driver.testing";
import { defaultFixtureFactory } from "../../fixtures";
import {
	setDefaultDriverFactory,
	setDefaultFixtureFactory,
	setDefaultHidRecovery,
	setDefaultNativeLog,
} from "../../session";

/** Appends one line to `$FIXTURE_LOG` (the runner test reads it back to assert ordering). */
export function fixtureLog(line: string): void {
	const path = process.env.FIXTURE_LOG;
	if (path !== undefined && path !== "") appendFileSync(path, `${line}\n`);
}

/** The fake device of this process, for specs that assert on driver calls. */
export const fake: { driver: FakeDriver | undefined } = { driver: undefined };

setDefaultNativeLog(undefined);
// the fake sim reboot only records the commands it would have run
setDefaultHidRecovery({
	exec: async (cmd) => {
		fixtureLog(`exec ${cmd.join(" ")}`);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
});
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

// the real app / device / screen over the fake driver; only the optional context log is added
setDefaultFixtureFactory(async (ctx) => {
	if (process.env.FIXTURE_LOG_CTX === "1") {
		fixtureLog(`ctx ${ctx.launch} action=${ctx.actionTimeoutMs} assertion=${ctx.assertionTimeoutMs}`);
	}
	return defaultFixtureFactory(ctx);
});
