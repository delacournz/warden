import { afterEach, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { result } from "../batch/results.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import type { E2eReport } from "./e2e";

export let dir: string;
export let write: (path: string, text: string) => void;
export let ctx: TestContext;
let ctxActive = false;

/** Assign the shared context (importers cannot assign a live binding). */
export function setCtx(c: TestContext): void {
	ctx = c;
	ctxActive = true;
}

/** the suites below were written for one spec process per spec; the device-isolation tests opt in */
export const SPEC_ISOLATION = { isolate: "spec" };

/** Register the per-test fixture repo + context cleanup; call once at the top of each e2e test file. */
export function useE2eFixture(): void {
	beforeEach(async () => {
		({ dir, write } = await makeSuiteRepo(SPEC_ISOLATION));
	});
	afterEach(() => {
		if (ctxActive) ctx.cleanup();
		ctxActive = false;
		rmSync(dir, { recursive: true, force: true });
	});
}

/** Swap the fixture for one whose suite has `overrides` (one spec process per spec unless they say otherwise). */
export async function resuite(overrides: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo({ ...SPEC_ISOLATION, ...overrides }, config));
}

/** Swap the fixture for a suite that says nothing about `isolate`, plus `overrides`. */
export async function resuiteDefault(overrides: Record<string, unknown> = {}): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo(overrides));
}

export function setup(argv: string[], calls: string[][] = []): TestContext {
	const sim = fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")], calls);
	const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
	setCtx(testContext(argv, { exec }));
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.cwd = dir;
	return ctx;
}

export async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
}

export const BUN = "/usr/bin/bun";
export const PRELOAD = "/proj/node_modules/@delacour/warden-e2e/src/preload.ts";

/** `bun test` argv of the default spec timeouts (2m + 30s) over these files */
export const bunTest = (...files: string[]) => [BUN, "test", "--preload", PRELOAD, "--timeout", "150000", ...files];

/** Where a spawned job's spec process writes `results.jsonl`. */
export const resultsPath = (env: Record<string, string | undefined>) => join(env.WARDEN_E2E_OUT ?? "", "results.jsonl");

/** `result()` for a spec file of the suite's specs dir. */
export const spec = (
	spec: string,
	title: string,
	status: TestResult["status"] = "passed",
	extra: Partial<TestResult> = {}
) => result(join(dir, `specs/${spec}.e2e.ts`), title, status, extra);

export const reportOf = (files: Map<string, string>, c: TestContext): E2eReport =>
	JSON.parse(files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e-report.json")) ?? "{}");

/** Fake `osascript` reply: one warden window on a screen; a screen read (the `NSScreen` probe) is logged to `reads`. */
export function windowListReply(script: string, reads: string[]): Awaited<ReturnType<Exec>> {
	if (script.includes("NSScreen")) reads.push("read");
	const windows = [{ title: "warden-iphone-17-1 – iOS 26.5", width: 400, height: 800 }];
	const screen = { x: 0, y: 0, width: 900, height: 900 };
	return { exitCode: 0, stdout: JSON.stringify({ screen, windows }), stderr: "" };
}

/** An exec for the late-window test: real git, window reads logged, the dev-client launch held until `launch` resolves. */
export function lateWindowExec(sim: Exec, launch: Promise<void>, reads: string[]): Exec {
	return async (cmd, opts) => {
		if (cmd[0] === "git") return bunExec(cmd, opts);
		if (cmd[0] === "osascript") return windowListReply(cmd[4] ?? "", reads);
		if (cmd[0] === "xcrun" && cmd[2] === "launch") {
			reads.push("launch:start");
			await launch;
		}
		return sim(cmd, opts);
	};
}
