import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { specGenerator } from "@delacour/warden-e2e/authoring/codegen";
import { journalStore } from "@delacour/warden-e2e/authoring/journal";
import type { RecordedStep, Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { RecordUsed, RecordVerify } from "../../contracts/record.schema";
import { uiPaths } from "../paths";
import type { OpOutcome, OpSession } from "../session";
import { snapshotOps } from "../snapshot";
import { authoringCommon } from "./common";
import { specConfigBuilder } from "./config";
import type { VerifyReport } from "./deps";
import { type SpecShape, specWriter } from "./generate";
import { helperRoutes } from "./helper-routes";
import type { RecordingPointer } from "./pointer";
import { routeTracker } from "./route";
import { specTargets } from "./spec-target";
import { verifyRun } from "./verify-run";

export type RecordUseParams = {
	/** `module#fn`: the helpers module (relative to the working directory) and its exported function */
	helper: string;
	/** `e2e.<name>` suite whose spec process runs the helper */
	suite?: string;
};

/** How long to wait for the screen the helper left behind before the fresh snapshot is taken. */
const USE_SETTLE_MS = 3_000;

const HELPER_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"] as const;

type UsedHelper = { module: string; fn: string };

/** One run of the generated spec that calls a helper, as `describeRun` reads it. */
type UseRun = { report: VerifyReport; verify: RecordVerify; evidence: string[] };

/** record use: runs a helper on the device and records it as a step. */
export class RecordUseOp {
	/** The helper's source file: the path as given, or with a TypeScript / JavaScript extension. */
	private helperFile(path: string): string | undefined {
		return [path, ...HELPER_EXTENSIONS.map((extension) => `${path.replace(/\.[cm]?[jt]sx?$/, "")}${extension}`)].find(
			(candidate) => existsSync(candidate) && !candidate.endsWith("/")
		);
	}

	/** Whether `source` exports `fn`: a declaration, or a name in an `export { … }` list. */
	private exportsHelper(source: string, fn: string): boolean {
		if (specTargets.exportsName(source, fn)) return true;
		const lists = source.matchAll(/^export\s*\{([^}]*)\}/gm);
		return [...lists].some((list) =>
			(list[1] ?? "").split(",").some((entry) => (entry.split(/\s+as\s+/).at(-1) ?? "").trim() === fn)
		);
	}

	/** The throwaway spec for one helper call, built by the same codegen a recording goes through. */
	private useSpec(recording: Recording, step: RecordedStep, shape: SpecShape, file: string): string {
		return specGenerator.generateSpec(
			{ ...recording, name: `use ${step.kind === "use" ? step.fn : "helper"}`, title: "use helper", steps: [step] },
			{ file, launch: shape.launch, ...(shape.specOptions !== undefined ? { specOptions: shape.specOptions } : {}) }
		).source;
	}

	/** The helper a `record use` names, checked: its file exists, exports the function, and is not the helper being recorded. */
	private resolveUsedHelper(
		session: OpSession,
		pointer: RecordingPointer,
		ref: string
	): Result<UsedHelper, WardenError> {
		const parsed = specTargets.parseHelperRef(ref);
		if (!parsed.success) return authoringCommon.failed("usage", parsed.error.replace("--helper", "record use"));
		const requested = resolve(session.host.cwd, parsed.data.module);
		const module = this.helperFile(requested);
		const { fn } = parsed.data;
		if (module === undefined) {
			return authoringCommon.failed("helper_missing", `${requested} does not exist`, {
				hint: "give the helpers module as <path>#<fn>, relative to the working directory",
			});
		}
		if (!this.exportsHelper(readFileSync(module, "utf8"), fn)) {
			return authoringCommon.failed("helper_missing", `${module} does not export ${fn}`, {
				hint: "export it, or record it first with `record start <name> --helper <module>#<fn>`",
			});
		}
		if (pointer.target.path === module && pointer.target.kind === "helper" && pointer.target.fn === fn) {
			return authoringCommon.failed("usage", `${fn} is the helper being recorded`);
		}
		return resultFactory.ok({ module, fn });
	}

	/** Run the helper once on the device through a throwaway one-test spec; nothing is recorded here. */
	private async runUseSpec(
		session: OpSession,
		pointer: RecordingPointer,
		recording: Recording,
		helper: UsedHelper,
		suiteName: string | undefined
	): Promise<Result<UseRun, WardenError>> {
		const suite = await authoringCommon.findSuiteOf(session, suiteName);
		if (!suite.success) {
			return authoringCommon.failed("verify_unavailable", `cannot run the helper: ${suite.error.message}`, {
				hint: "fix the suite config or pass --suite <name>",
			});
		}
		const stamp = String(session.host.now());
		const outDir = join(uiPaths.uiDir(session.host.home, session.device.id), "use", stamp);
		const specDir = join(suite.data.cwd, "node_modules", ".cache", "warden-use", stamp);
		const specPath = join(specDir, "use.e2e.ts");
		const useStep: RecordedStep = { i: 0, at: session.host.now(), kind: "use", module: helper.module, fn: helper.fn };
		const shape = await specWriter.specShapeFor(
			session,
			pointer,
			{ ...recording, steps: [useStep] },
			specPath,
			suiteName
		);
		authoringCommon.write(specPath, this.useSpec(recording, useStep, shape, specPath));
		let ran: Result<VerifyReport, string>;
		try {
			ran = await verifyRun.runSpec(session, verifyRun.verifyInputFor(session, specPath, suite.data, outDir));
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
		if (!ran.success) {
			return authoringCommon.failed("verify_unavailable", `cannot run the helper: ${ran.error}`, {
				hint: "nothing was recorded; fix it and run `record use` again",
			});
		}
		return resultFactory.ok({ report: ran.data, ...verifyRun.describeRun(ran.data) });
	}

	/** A helper that failed on the device records nothing. */
	private useFailed(session: OpSession, run: UseRun, helper: UsedHelper): { success: false; error: WardenError } {
		const { report, verify, evidence } = run;
		verifyRun.printFailures(session, report, evidence);
		return authoringCommon.failed("use_failed", `${helper.fn} failed on the device (exit ${report.exitCode})`, {
			hint: "read screen-at-failure.txt, fix the helper or the app, then run `record use` again; nothing was recorded",
			details: { module: helper.module, fn: helper.fn, verify, evidence },
		});
	}

	/** Take a fresh snapshot once the screen the helper left behind has settled. */
	private async snapshotAfterUse(session: OpSession): Promise<void> {
		const driver = await session.driver();
		if (!driver.success) return;
		await snapshotOps.takeSnapshot(session, driver.data, {
			interactiveOnly: true,
			all: false,
			settle: { budgetMs: USE_SETTLE_MS },
		});
	}

	/** The `routes:` line of a recorded `use`. */
	private useRoutesLine(visited: readonly string[], partial: boolean): string {
		if (visited.length === 0) return "routes: none read (not a dev client)";
		const source = partial
			? " (only the reads before and after the run: the helper has no recording of its own)"
			: " (from its recording)";
		return `routes: ${visited.join(", ")}${source}`;
	}

	/** Append the passed `use` to the journal, with the routes the helper visited. */
	private async recordUseStep(
		session: OpSession,
		journal: string,
		helper: UsedHelper,
		verify: RecordVerify
	): OpOutcome<RecordUsed> {
		const { module, fn } = helper;
		const before = session.state.read().recording?.routes?.last;
		const route = await routeTracker.captureRoute(session);
		const after = session.state.read().recording?.routes?.last;
		const recorded = helperRoutes.loadHelperRoutes(session.host.home, module, fn);
		const visited = specConfigBuilder.visitedRoutes(before, recorded ?? [], after);
		const partial = recorded === undefined || recorded.length === 0;
		const appended = await journalStore.appendStep(journal, {
			kind: "use",
			at: session.host.now(),
			module,
			fn,
			...(route !== undefined ? { route } : {}),
			visited,
			...(partial ? { partial: true as const } : {}),
		});
		if (!appended.success) return authoringCommon.journalFailure(appended.error);
		return resultFactory.ok({
			result: {
				outcome: "used",
				step: appended.data.i,
				module,
				fn,
				...(route !== undefined ? { route } : {}),
				visited,
				routes: partial ? "reads" : "recording",
				verify,
			},
			text: [
				`${fn} passed on ${session.device.id}; recorded as step ${appended.data.i} (await ${fn}(fixtures)). Next: \`wait\` for a testID of the screen it leaves you on`,
				this.useRoutesLine(visited, partial),
			].join("\n"),
		});
	}

	/**
	 * `record use <module#fn>`: run the helper once on this device (a generated one-test spec through the same spec
	 * process `record stop` verifies with), and only when it passes append a `use` step. The spec then calls
	 * `await fn(fixtures)`. The next snapshot, refs and route start from the screen the helper left behind. A failing
	 * helper records nothing.
	 */
	async run(session: OpSession, params: RecordUseParams): OpOutcome<RecordUsed> {
		const active = authoringCommon.activeRecording(session);
		if (!active.success) return active;
		const { pointer, journal } = active.data;
		const helper = this.resolveUsedHelper(session, pointer, params.helper);
		if (!helper.success) return helper;
		const read = journalStore.readJournal(journal);
		if (!read.success) return authoringCommon.journalFailure(read.error, "`warden ui record cancel` clears it");
		const run = await this.runUseSpec(session, pointer, read.data, helper.data, params.suite ?? pointer.suite);
		if (!run.success) return run;
		if (!run.data.report.passed) return this.useFailed(session, run.data, helper.data);
		await this.snapshotAfterUse(session);
		return this.recordUseStep(session, journal, helper.data, run.data.verify);
	}
}

export const recordUseOp = new RecordUseOp();
