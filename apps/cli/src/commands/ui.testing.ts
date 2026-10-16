import { expect } from "bun:test";
import {
	type DriverCall,
	type ElementSpec,
	el,
	type FakeDriver,
	type FakeOverride,
	fakeDriver,
} from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { ok } from "@delacour/warden-types/result";
import type { UiDeps } from "../agent-ui/driver";
import type { RecordStep } from "../agent-ui/record";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createUiCommand } from "./ui";

/** Test harness shared by the `warden ui` command tests: a leased device, fake driver, fake clock. */

export const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

export const LOGIN: ElementSpec[] = [
	el("window", {
		children: [
			el("text", { label: "Welcome" }),
			el("textfield", { label: "Email", id: "email", value: "a@b.co" }),
			el("button", { label: "Sign in", id: "sign-in-submit", hittable: true }),
			el("image", { label: "logo" }),
		],
	}),
];

export type Harness = {
	c: TestContext;
	clock: { t: number };
	driver: FakeDriver;
	steps: RecordStep[];
	run: (...argv: string[]) => Promise<number>;
};

export type HarnessOptions = {
	onCall?: (call: DriverCall, driver: FakeDriver) => FakeOverride | undefined;
	video?: UiDeps["video"];
};

const live: TestContext[] = [];

/** Call from `afterEach`: removes every temp `WARDEN_HOME` the harnesses made. */
export function cleanupHarnesses(): void {
	for (const c of live.splice(0)) c.cleanup();
}

/** A leased device, a fake clock that `sleep` advances, a fake driver over `screens`, and a recording sink. */
export function harness(screens: Snapshot[] | (() => Snapshot), options: HarnessOptions = {}): Harness {
	const clock = { t: 1_000_000 };
	const steps: RecordStep[] = [];
	const driver: FakeDriver = fakeDriver({
		screens,
		onCall: (call) => options.onCall?.(call, driver),
	});
	const deps: UiDeps = {
		driver: async () => ok(driver),
		sleep: async (ms) => {
			clock.t += ms;
		},
		record: {
			append: async (_udid, step) => {
				steps.push(step);
			},
		},
		...(options.video ? { video: options.video } : {}),
	};
	const c = testContext([], { now: () => clock.t });
	live.push(c);
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		clock.t
	);
	const command = createUiCommand(deps);
	return {
		c,
		clock,
		driver,
		steps,
		run: (...argv) => {
			c.argv = [...argv, "--udid", UDID];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
	};
}

/** The one JSON document a `--json` run printed. */
export const doc = (c: TestContext) => {
	expect(c.stdout).toHaveLength(1);
	return JSON.parse(c.stdout[0] ?? "");
};
