import { expect } from "bun:test";
import type { PidAlive } from "@delacour/warden-core/liveness";
import {
	type DriverCall,
	type ElementSpec,
	el,
	type FakeDriver,
	type FakeOverride,
	fakeDriver,
} from "@delacour/warden-e2e/driver/driver.testing";
import type { DriverCapabilities, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
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
	/** how many times a subcommand opened the driver */
	opens: { count: number };
};

export type HarnessOptions = {
	onCall?: (call: DriverCall, driver: FakeDriver) => FakeOverride | undefined;
	/** the fake driver offers select-all (like the iOS driver) */
	selectAll?: boolean;
	/** the fake driver offers `pasteText` (like the iOS driver) */
	pasteText?: boolean;
	/** the fake driver offers `setText` (like the Android driver with `warden-uiad`) */
	setText?: boolean;
	/** a tap on an alert's button answers it (the alert then reads as gone), like a real device */
	answerAlertOnTap?: boolean;
	/** override the fake driver's capabilities (e.g. `pinch: false`, `maxPointers: 1`) */
	capabilities?: Partial<DriverCapabilities>;
	video?: UiDeps["video"];
	/** the device lease's holder pid + label (a running `warden e2e` / `batch` / `run` sets both) */
	lease?: { pid?: number; label?: string; shared?: boolean };
	/** the pid liveness probe `warden ui` uses (default: the real one) */
	pidAlive?: PidAlive;
	/** what `open --kind` installs with (default: the real ensure) */
	ensureApp?: UiDeps["ensureApp"];
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
		...(options.selectAll ? { selectAll: true } : {}),
		...(options.setText ? { setText: true } : {}),
		...(options.pasteText ? { pasteText: true } : {}),
		...(options.answerAlertOnTap ? { answerAlertOnTap: true } : {}),
		...(options.capabilities ? { capabilities: options.capabilities } : {}),
		onCall: (call) => options.onCall?.(call, driver),
	});
	const opens = { count: 0 };
	const deps: UiDeps = {
		driver: async () => {
			opens.count += 1;
			return ok(driver);
		},
		sleep: async (ms) => {
			clock.t += ms;
		},
		record: {
			append: async (_udid, step) => {
				steps.push(step);
			},
		},
		...(options.video ? { video: options.video } : {}),
		...(options.pidAlive ? { pidAlive: options.pidAlive } : {}),
		...(options.ensureApp ? { ensureApp: options.ensureApp } : {}),
	};
	const c = testContext([], { now: () => clock.t });
	live.push(c);
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
			...(options.lease?.pid !== undefined ? { pid: options.lease.pid } : {}),
			...(options.lease?.label !== undefined ? { label: options.lease.label } : {}),
			...(options.lease?.shared ? { shared: true } : {}),
		},
		clock.t
	);
	const command = createUiCommand(deps);
	return {
		c,
		clock,
		driver,
		steps,
		opens,
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
