import { existsSync } from "node:fs";
import { join } from "node:path";
import { journalStore } from "@delacour/warden-e2e/authoring/journal";
import { type LintFinding, recordingLinter } from "@delacour/warden-e2e/authoring/lint";
import type { Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { RecordSpecConfig, RecordStopped, RecordVerify } from "../../contracts/record.schema";
import { uiPaths } from "../paths";
import type { OpDone, OpOutcome, OpSession } from "../session";
import {
	activeRecording,
	clearPointer,
	colorOf,
	depsOf,
	failed,
	findSuiteOf,
	journalFailure,
	lintLines,
	updatePointer,
} from "./common";
import {
	configForTarget,
	rememberHelperRoutes,
	type SpecShape,
	shapeForTarget,
	shapeLines,
	type Written,
	writeTarget,
} from "./generate";
import type { RecordingPointer } from "./pointer";
import { describeRun, printFailures, runSpec, verifyInputFor } from "./verify-run";

export type RecordStopParams = {
	/** run the written spec once on the device (default true; a helper is never run) */
	verify?: boolean;
	/** replace an existing spec file, or an existing helper function */
	overwrite?: boolean;
	/** `e2e.<name>` suite to verify in */
	suite?: string;
};

/** Everything `stop` knows once the target is written. */
type StopOutcome = {
	pointer: RecordingPointer;
	recording: Recording;
	written: Written;
	lints: readonly LintFinding[];
	fixmes: number;
	config: RecordSpecConfig | null;
	shape: SpecShape;
};

type Summary = Omit<RecordStopped, "outcome" | "verify">;

type Finish = (verify: RecordVerify, lines: string[], outcome: "verified" | "written") => OpDone<RecordStopped>;

const fixmesIn = (source: string): number => (source.match(/^\s*\/\/ FIXME:/gm) ?? []).length;

function configLines(config: RecordSpecConfig, suite: string | undefined): string[] {
	return [
		`add to ${suite === undefined ? "the suite" : `e2e.${suite}`} in warden.config.ts:`,
		...config.snippet.split("\n").map((line) => `  ${line}`),
		...config.hints.map((hint) => `  note: ${hint}`),
	];
}

/** `stop` replaces an existing spec only with `overwrite` (now or at `start`), or when this recording already wrote it. */
function checkTargetFree(pointer: RecordingPointer, overwrite: boolean): Result<undefined, WardenError> {
	const { target } = pointer;
	const taken = target.kind === "spec" && existsSync(target.path) && pointer.wrote !== true && !overwrite;
	if (!taken) return resultFactory.ok(undefined);
	return failed("target_exists", `${target.path} already exists`, { hint: "pass --overwrite to replace it" });
}

/** The `--json` fields of a stopped recording, minus the outcome and the verify verdict. */
function stopSummary(outcome: StopOutcome): Summary {
	const { pointer, recording, written, lints, fixmes, config, shape } = outcome;
	return {
		kind: pointer.target.kind,
		name: recording.name,
		file: written.file,
		...(written.fn !== undefined ? { fn: written.fn, replaced: written.replaced } : {}),
		steps: recording.steps.length,
		ids: written.ids,
		lints: [...lints],
		fixmes,
		config,
		...(pointer.target.kind === "spec"
			? {
					options: shape.specOptions ? { module: shape.specOptions.module, name: shape.specOptions.name } : null,
					launch: shape.launch,
				}
			: {}),
	};
}

/** The lines about the ids module `stop` touched. */
function idsLines(ids: Written["ids"]): string[] {
	if (!ids || Object.keys(ids.added).length === 0) return [];
	return [`updated ${ids.file}`, ...Object.entries(ids.added).map(([key, id]) => `  + ${key}: ${JSON.stringify(id)}`)];
}

/** The text of a stopped recording, before the verify lines. */
function wroteLines(session: OpSession, outcome: StopOutcome): string[] {
	const { pointer, recording, written, lints, fixmes, config, shape } = outcome;
	const steps = recording.steps.length;
	const fn = written.fn !== undefined ? ` (${written.fn}${written.replaced ? ", replaced" : ""})` : "";
	return [
		`wrote ${written.file}${fn}: ${steps} step${steps === 1 ? "" : "s"}`,
		...idsLines(written.ids),
		...(fixmes > 0 ? [`${fixmes} FIXME to resolve before committing`] : []),
		...shapeLines(shape, pointer.target.path),
		...lintLines(lints, colorOf(session)),
		...(config ? configLines(config, config.suite) : []),
	];
}

/** Ends the recording once it is written (and verified): drops the journal and the pointer, shapes the result. */
function makeFinish(session: OpSession, journal: string, summary: Summary, wrote: string[]): Finish {
	return (verify, lines, outcome) => {
		journalStore.deleteJournal(journal);
		clearPointer(session);
		return { result: { outcome, ...summary, verify }, text: [...wrote, ...lines].join("\n") };
	};
}

/** A helper is not a spec and `verify: false` skips the run: the finished result then, else undefined. */
function skippedVerify(kind: "spec" | "helper", verify: boolean, finish: Finish): OpDone<RecordStopped> | undefined {
	if (kind === "helper") {
		return finish(
			{ status: "skipped", reason: "helper" },
			[
				"verify skipped: a helper is not a spec — run a spec that calls it (`warden e2e <suite> --specs <id>`) to check it",
			],
			"written"
		);
	}
	if (!verify) return finish({ status: "skipped", reason: "flag" }, ["verify skipped (--no-verify)"], "written");
	return undefined;
}

/** The journal `stop` turns into a file: read, linted, and not empty. */
function readStoppable(journal: string): Result<{ recording: Recording; lints: LintFinding[] }, WardenError> {
	const read = journalStore.readJournal(journal);
	if (!read.success) return journalFailure(read.error, "`warden ui record cancel` clears it");
	const lints = recordingLinter.lintRecording(read.data);
	if (lints.some((lint) => lint.code === "empty_recording")) {
		return failed("empty_recording", "the recording has no steps", {
			hint: "drive the app with warden ui actions after `record start`, or `record cancel`",
		});
	}
	return resultFactory.ok({ recording: read.data, lints });
}

/** Run the written spec once; success finishes the recording, anything else keeps it. */
async function verifyWritten(
	session: OpSession,
	pointer: RecordingPointer,
	suiteName: string | undefined,
	summary: Summary,
	wrote: string[],
	finish: Finish
): OpOutcome<RecordStopped> {
	const out = depsOf(session).err;
	const keep = (error: WardenError): { success: false; error: WardenError } => {
		if (out) for (const line of wrote) out(line);
		return { success: false, error: { ...error, details: { ...summary, ...error.details } } };
	};
	const suite = await findSuiteOf(session, suiteName);
	if (!suite.success) {
		return keep(
			failed("verify_unavailable", `cannot verify: ${suite.error.message}`, {
				hint: "fix the suite config or pass --suite <name>, then `record stop` again; --no-verify skips it. The journal is kept",
			}).error
		);
	}
	const outDir = join(uiPaths.uiDir(session.host.home, session.device.id), "verify", String(session.host.now()));
	const ran = await runSpec(session, verifyInputFor(session, pointer.target.path, suite.data, outDir));
	if (!ran.success) {
		return keep(
			failed("verify_unavailable", `cannot verify: ${ran.error}`, {
				hint: "fix it and `record stop` again; --no-verify skips it. The journal is kept",
			}).error
		);
	}
	const report = ran.data;
	const { verify, evidence } = describeRun(report);
	if (report.passed) {
		const count = report.tests.length;
		return resultFactory.ok(
			finish(verify, [`verified: ${count} test${count === 1 ? "" : "s"} passed on ${session.device.id}`], "verified")
		);
	}
	printFailures(session, report, evidence);
	return keep(
		failed("verify_failed", `the spec failed on the device (exit ${report.exitCode})`, {
			hint: "read screen-at-failure.txt, fix the app or `record undo` and redo the step, then `record stop` again; `record cancel` drops it. The file and the journal are kept",
			details: { verify, evidence },
		}).error
	);
}

/**
 * `record stop`: write the spec (or helper), merge the ids module, report the lints and, unless `verify: false` (or a
 * helper), run the spec once on this device. A failed verify keeps both the file and the journal: `record undo` / fix
 * the app / `record stop` again, or `record cancel`. The journal is removed only on success.
 */
export async function recordStop(session: OpSession, params: RecordStopParams = {}): OpOutcome<RecordStopped> {
	const active = activeRecording(session);
	if (!active.success) return active;
	const { pointer, journal } = active.data;
	const stoppable = readStoppable(journal);
	if (!stoppable.success) return stoppable;
	const { recording, lints } = stoppable.data;
	const overwrite = params.overwrite === true || pointer.overwrite === true;
	const free = checkTargetFree(pointer, overwrite);
	if (!free.success) return free;
	const suiteName = params.suite ?? pointer.suite;
	const shape = await shapeForTarget(session, pointer, recording, suiteName);
	const written = writeTarget(pointer, recording, overwrite, shape);
	if (!written.success) return written;
	updatePointer(session, (current) => ({ ...current, wrote: true }));
	const config = await configForTarget(session, pointer, recording, suiteName);
	if (pointer.target.kind === "helper") await rememberHelperRoutes(session, pointer, recording);
	const outcome: StopOutcome = {
		pointer,
		recording,
		written: written.data,
		lints,
		fixmes: fixmesIn(written.data.source),
		config,
		shape,
	};
	const summary = stopSummary(outcome);
	const wrote = wroteLines(session, outcome);
	const finish = makeFinish(session, journal, summary, wrote);
	const skipped = skippedVerify(pointer.target.kind, params.verify !== false, finish);
	if (skipped) return resultFactory.ok(skipped);
	return verifyWritten(session, pointer, suiteName, summary, wrote, finish);
}
