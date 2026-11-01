import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepos } from "@delacour/warden-core/testing/fixture.testing";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { recordingSchema } from "@delacour/warden-e2e/authoring/recording.schema";
import { processExec } from "@delacour/warden-runtime/exec";
import { resultFactory } from "@delacour/warden-types/result";
import { recordResultSchema } from "../../contracts/record.schema";
import { actionOps } from "../actions";
import { uiPaths } from "../paths";
import { refStores } from "../ref-store";
import type { OpSession } from "../session";
import { snapshotOps } from "../snapshot";
import { stateStores } from "../state-store";
import type { AuthoringDeps, VerifyInput, VerifyReport } from "./deps";
import { journalOps } from "./journal-ops";
import { journalRecorders } from "./recorder";
import { recordStartOp } from "./start";
import { recordStopOp } from "./stop";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

const SCREEN = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("textfield", {
				label: "Email",
				id: "email",
				value: "a@b.co",
				frame: { x: 0, y: 100, width: 390, height: 44 },
			}),
			driverFixtures.el("button", {
				label: "Sign in",
				id: "sign-in-submit",
				hittable: true,
				frame: { x: 0, y: 150, width: 390, height: 44 },
			}),
		],
	}),
]);

let cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
});

const report = (input: VerifyInput, passed: boolean): VerifyReport => ({
	passed,
	exitCode: passed ? 0 : 1,
	outDir: input.outDir,
	log: join(input.outDir, "spec.log"),
	results: join(input.outDir, "results.jsonl"),
	tests: [
		{
			title: "sign-in",
			status: passed ? "passed" : "failed",
			durationMs: 5,
			evidence: passed ? [] : [join(input.outDir, "screen-at-failure.txt")],
		},
	],
});

type Rig = {
	session: OpSession;
	cwd: string;
	home: string;
	verified: VerifyInput[];
	verdict: { passed: boolean };
	stderr: string[];
};

/** A session over a FakeDriver in a repo with an `e2e.mobile` suite, the real journal and codegen, and a faked spec run. */
async function rig(options: { withVerify?: boolean } = {}): Promise<Rig> {
	const repo = await fixtureRepos.createSuite();
	const home = join(repo.dir, ".home");
	cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
	const driver = new FakeDriver({ screens: [SCREEN] });
	const verified: VerifyInput[] = [];
	const verdict = { passed: true };
	const stderr: string[] = [];
	const clock = { t: 1_000_000 };
	const state = stateStores.createMemoryStateStore();
	const refs = refStores.createMemoryRefStore();
	const authoring: AuthoringDeps = {
		err: (line) => stderr.push(line),
		...(options.withVerify === false
			? {}
			: {
					verify: async (input) => {
						verified.push(input);
						return resultFactory.ok(report(input, verdict.passed));
					},
				}),
	};
	const session: OpSession = {
		device: { id: UDID, platform: "ios", name: "sim" },
		host: {
			env: { WARDEN_UI_SECRET_PASSWORD: "hunter22" },
			cwd: repo.dir,
			home,
			now: () => clock.t,
			exec: processExec.run,
			sleep: async (ms) => {
				clock.t += ms;
			},
		},
		driver: async () => resultFactory.ok(driver),
		refs,
		state,
		timeoutMs: 5000,
		authoring,
	};
	session.recorder = journalRecorders.journalRecorder({
		home,
		env: session.host.env,
		now: session.host.now,
		state,
		refs,
		warn: (message) => stderr.push(message),
	});
	session.routeAfter = journalRecorders.routeAfterFor(state, () => session);
	return { session, cwd: repo.dir, home, verified, verdict, stderr };
}

function must<T>(done: { success: true; data: T } | { success: false; error: { code: string; message: string } }): T {
	if (!done.success) throw new Error(`${done.error.code}: ${done.error.message}`);
	return done.data;
}

describe("session.record ops", () => {
	test("start → journalled actions → note/undo/status → stop writes the spec and verifies it", async () => {
		const r = await rig();
		const started = must(await recordStartOp.run(r.session, { name: "Sign in", suite: "mobile" }));
		expect(recordResultSchema.parse(started.result)).toMatchObject({
			outcome: "started",
			kind: "spec",
			target: join(r.cwd, "specs", "sign-in.e2e.ts"),
			journal: uiPaths.recordingFile(r.home, UDID),
		});
		expect(r.session.state.read().recording).toMatchObject({ name: "Sign in", suite: "mobile" });

		must(await snapshotOps.snapshot(r.session, {}));
		must(await journalOps.recordNote(r.session, { text: "press sign in" }));
		must(await actionOps.press(r.session, { target: "id=sign-in-submit" }));
		must(await actionOps.press(r.session, { target: "id=sign-in-submit" }));

		const journal = recordingSchema.parse(JSON.parse(readFileSync(uiPaths.recordingFile(r.home, UDID), "utf8")));
		expect(journal.steps.map((step) => step.kind)).toEqual(["note", "press", "press"]);

		const status = must(await journalOps.recordStatus(r.session));
		expect(recordResultSchema.parse(status.result)).toMatchObject({ outcome: "recording", recording: { steps: 3 } });

		const undone = must(await journalOps.recordUndo(r.session, { count: 1 }));
		expect(recordResultSchema.parse(undone.result)).toMatchObject({ outcome: "undone", steps: 2 });

		const stopped = must(await recordStopOp.run(r.session, {}));
		const result = recordResultSchema.parse(stopped.result);
		expect(result).toMatchObject({ outcome: "verified", kind: "spec", steps: 2, verify: { status: "passed" } });
		const file = join(r.cwd, "specs", "sign-in.e2e.ts");
		expect(readFileSync(file, "utf8")).toContain("sign-in-submit");
		expect(r.verified).toHaveLength(1);
		expect(r.verified[0]).toMatchObject({ udid: UDID, platform: "ios", specPath: file });
		expect(r.verified[0]?.suite.name).toBe("mobile");
		expect(existsSync(uiPaths.recordingFile(r.home, UDID))).toBe(false);
		expect(r.session.state.read().recording).toBeUndefined();
	});

	test("a failing verify keeps the file and the journal; cancel leaves the written spec", async () => {
		const r = await rig();
		must(await recordStartOp.run(r.session, { name: "x", suite: "mobile" }));
		must(await actionOps.press(r.session, { target: "id=sign-in-submit" }));
		r.verdict.passed = false;
		const failed = await recordStopOp.run(r.session, {});
		expect(!failed.success && failed.error.code).toBe("verify_failed");
		expect(existsSync(join(r.cwd, "specs", "x.e2e.ts"))).toBe(true);
		expect(existsSync(uiPaths.recordingFile(r.home, UDID))).toBe(true);
		expect(r.stderr.some((line) => line.includes("sign-in"))).toBe(true);

		r.verdict.passed = true;
		const again = must(await recordStopOp.run(r.session, {}));
		expect(recordResultSchema.parse(again.result)).toMatchObject({ outcome: "verified" });
	});

	test("without a spec runner stop reports verify_unavailable, and verify: false writes without running", async () => {
		const r = await rig({ withVerify: false });
		must(await recordStartOp.run(r.session, { name: "x", suite: "mobile" }));
		must(await actionOps.press(r.session, { target: "id=sign-in-submit" }));
		const unavailable = await recordStopOp.run(r.session, {});
		expect(!unavailable.success && unavailable.error.code).toBe("verify_unavailable");
		expect(existsSync(uiPaths.recordingFile(r.home, UDID))).toBe(true);

		const written = must(await recordStopOp.run(r.session, { verify: false }));
		expect(recordResultSchema.parse(written.result)).toMatchObject({
			outcome: "written",
			verify: { status: "skipped", reason: "flag" },
		});
	});

	test("nothing is journalled without a recording; every command but status needs one", async () => {
		const r = await rig();
		must(await actionOps.press(r.session, { target: "id=sign-in-submit" }));
		expect(existsSync(uiPaths.recordingFile(r.home, UDID))).toBe(false);
		expect(must(await journalOps.recordStatus(r.session)).result).toEqual({ outcome: "idle", recording: null });
		for (const done of [
			await journalOps.recordNote(r.session, { text: "x" }),
			await journalOps.recordUndo(r.session),
			await journalOps.recordCancel(r.session),
			await recordStopOp.run(r.session),
		]) {
			expect(!done.success && done.error.code).toBe("no_recording");
		}
	});

	test("start refuses a second recording and an existing target without overwrite", async () => {
		const r = await rig();
		must(await recordStartOp.run(r.session, { name: "x", suite: "mobile" }));
		const second = await recordStartOp.run(r.session, { name: "y" });
		expect(!second.success && second.error.code).toBe("recording_active");
		must(await journalOps.recordCancel(r.session));
		must(
			await recordStartOp.run(r.session, { name: "chats", suite: "mobile", to: "specs/chats.e2e.ts", overwrite: true })
		);
		must(await journalOps.recordCancel(r.session));
		const taken = await recordStartOp.run(r.session, { name: "chats", suite: "mobile", to: "specs/chats.e2e.ts" });
		expect(!taken.success && taken.error.code).toBe("target_exists");
	});
});
