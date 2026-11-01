import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/testing/fixture.testing";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { recordingSchema } from "@delacour/warden-e2e/authoring/recording.schema";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import { processExec } from "@delacour/warden-runtime/exec";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { createWardenClient } from "./client";
import type { ClientSeams } from "./core";
import { isWardenError } from "./errors";
import type { VerifyInput } from "./ops/authoring/deps";
import { recordingFile } from "./ops/paths";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

const SCREEN = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("button", {
				label: "Sign in",
				id: "sign-in-submit",
				hittable: true,
				frame: { x: 0, y: 150, width: 390, height: 44 },
			}),
		],
	}),
]);

let home: string;
let repoDir: string;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "warden-sdk-record-"));
	repoDir = (await makeSuiteRepo()).dir;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
});

const provider: DeviceProvider = {
	platform: "ios",
	inventory: async () =>
		resultFactory.ok([
			{
				platform: "ios",
				id: UDID,
				name: "warden-iphone-17-1",
				state: "booted",
				wardenCreated: false,
				runtime: "iOS-26-5",
			},
		]),
	create: async () => wardenErrors.err("failed", "no create"),
	boot: async () => resultFactory.ok(undefined),
	waitReady: async () => resultFactory.ok(undefined),
	shutdown: async () => resultFactory.ok(undefined),
};

test("session.record journals interactions and stop writes a verified spec", async () => {
	const verified: VerifyInput[] = [];
	const seams: ClientSeams = {
		providerFor: () => provider,
		stopHelper: async () => undefined,
		openDriver: async () => resultFactory.ok(new FakeDriver({ screens: [SCREEN] })),
		authoring: {
			verify: async (input) => {
				verified.push(input);
				return resultFactory.ok({
					passed: true,
					exitCode: 0,
					outDir: input.outDir,
					log: join(input.outDir, "spec.log"),
					results: join(input.outDir, "results.jsonl"),
					tests: [{ title: "sign in", status: "passed", durationMs: 3, evidence: [] }],
				});
			},
		},
	};
	await using warden = createWardenClient(
		{
			home,
			host: {
				env: {
					WARDEN_CAPACITY: "off",
					WARDEN_ARRANGE: "0",
					WARDEN_BACKGROUND: "0",
					WARDEN_HOME: home,
					HOME: "/nonexistent",
				},
				cwd: repoDir,
				exec: processExec.run,
			},
		},
		seams
	);
	const [lease] = await warden.leases.claim({ platform: "ios" });
	await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });

	expect(await session.record.status()).toEqual({ outcome: "idle", recording: null });
	const started = await session.record.start({ name: "sign in", suite: "mobile" });
	expect(started).toMatchObject({ outcome: "started", kind: "spec", target: join(repoDir, "specs", "sign-in.e2e.ts") });

	await session.capture.snapshot({ interactiveOnly: true });
	await session.record.note("press the button");
	await session.interactions.press({ selector: "id=sign-in-submit" });

	const journal = recordingSchema.parse(JSON.parse(readFileSync(recordingFile(home, UDID), "utf8")));
	expect(journal.steps.map((step) => step.kind)).toEqual(["note", "press"]);

	const stopped = await session.record.stop();
	expect(stopped).toMatchObject({ outcome: "verified", verified: true, steps: 2 });
	expect(stopped.configSnippet).toContain("specs:");
	expect(readFileSync(join(repoDir, "specs", "sign-in.e2e.ts"), "utf8")).toContain("sign-in-submit");
	expect(verified).toHaveLength(1);
	expect(existsSync(recordingFile(home, UDID))).toBe(false);
});

test("session.record throws a typed WardenError", async () => {
	await using warden = createWardenClient(
		{
			home,
			host: {
				env: { WARDEN_CAPACITY: "off", WARDEN_ARRANGE: "0", WARDEN_HOME: home, HOME: "/nonexistent" },
				cwd: repoDir,
			},
		},
		{
			providerFor: () => provider,
			stopHelper: async () => undefined,
			openDriver: async () => resultFactory.ok(new FakeDriver({ screens: [SCREEN] })),
		}
	);
	const [lease] = await warden.leases.claim({ platform: "ios" });
	await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
	const thrown = await session.record.stop().then(
		() => undefined,
		(error: unknown) => error
	);
	expect(isWardenError(thrown) && thrown.code).toBe("no_recording");
});

test("stop verifies through the specs runner by default: `warden e2e --specs <id> --json` via cliCommand", async () => {
	const argvs: string[][] = [];
	const report = {
		suite: "mobile",
		platform: "ios",
		isolate: "device",
		ok: true,
		headless: false,
		batchDir: "/tmp/batch",
		specs: [
			{
				id: "sign-in",
				file: "specs/sign-in.e2e.ts",
				required: true,
				reasons: [{ kind: "requested", pattern: "sign-in" }],
				verdict: "passed",
				attempts: 1,
				tests: [{ title: ["sign in"], status: "passed", durationMs: 5 }],
			},
		],
	};
	await using warden = createWardenClient(
		{
			home,
			cliCommand: ["my-warden"],
			host: {
				env: { WARDEN_CAPACITY: "off", WARDEN_ARRANGE: "0", WARDEN_HOME: home, HOME: "/nonexistent" },
				cwd: repoDir,
				exec: processExec.run,
			},
		},
		{
			providerFor: () => provider,
			stopHelper: async () => undefined,
			openDriver: async () => resultFactory.ok(new FakeDriver({ screens: [SCREEN] })),
			specs: {
				spawn: async (argv) => {
					argvs.push([...argv]);
					return { exitCode: 0, stdout: JSON.stringify(report), stderr: "" };
				},
			},
		}
	);
	const [lease] = await warden.leases.claim({ platform: "ios" });
	await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
	await session.record.start({ name: "sign in", suite: "mobile" });
	await session.capture.snapshot({ interactiveOnly: true });
	await session.interactions.press({ selector: "id=sign-in-submit" });

	const stopped = await session.record.stop();
	expect(stopped).toMatchObject({ outcome: "verified", verified: true });
	expect(argvs).toEqual([["my-warden", "e2e", "mobile", "--json", "--specs", "sign-in", "--platform", "ios"]]);
});
