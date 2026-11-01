import { appendFileSync, writeFileSync } from "node:fs";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { sessionFixtures } from "../../fixtures";
import { sessions } from "../../session";

export class FixtureLog {
	/** Appends one line to `$FIXTURE_LOG` (the runner test reads it back to assert ordering). */
	write(line: string): void {
		const path = process.env.FIXTURE_LOG;
		if (path !== undefined && path !== "") appendFileSync(path, `${line}\n`);
	}
}

export const fixtureLog = new FixtureLog();

/** The fake device of this process, for specs that assert on driver calls. */
export const fake: { driver: FakeDriver | undefined } = { driver: undefined };

sessions.setDefaultNativeLog(undefined);
// the fake sim reboot only records the commands it would have run
sessions.setDefaultHidRecovery({
	exec: async (cmd) => {
		fixtureLog.write(`exec ${cmd.join(" ")}`);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
});
sessions.setDefaultDriverFactory(async (env) => {
	fake.driver = new FakeDriver({
		platform: env.platform,
		id: env.udid,
		screens: [
			driverFixtures.snapshotOf([
				driverFixtures.el("button", { label: "Sign in", id: "sign-in" }),
				driverFixtures.el("text", { label: "Welcome" }),
			]),
		],
		onCall(call) {
			if (call.method === "screenshot" && call.opts?.path !== undefined) writeFileSync(call.opts.path, "PNG");
			return undefined;
		},
	});
	return { success: true, data: fake.driver };
});

// the real app / device / screen over the fake driver; only the optional context log is added
sessions.setDefaultFixtureFactory(async (ctx) => {
	if (process.env.FIXTURE_LOG_CTX === "1") {
		fixtureLog.write(`ctx ${ctx.launch} action=${ctx.actionTimeoutMs} assertion=${ctx.assertionTimeoutMs}`);
	}
	return sessionFixtures.defaultFixtureFactory(ctx);
});
