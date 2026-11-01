import { existsSync } from "node:fs";
import { journalStore } from "@delacour/warden-e2e/authoring/journal";
import { recordingStatusReader } from "@delacour/warden-e2e/authoring/status";
import { resultFactory } from "@delacour/warden-types/result";
import type {
	RecordCancelled,
	RecordIdle,
	RecordNoted,
	RecordStatus,
	RecordUndone,
} from "../../contracts/record.schema";
import type { OpOutcome, OpSession } from "../session";
import {
	activeRecording,
	clearPointer,
	colorOf,
	failed,
	journalFailure,
	journalOf,
	lintLines,
	targetPath,
} from "./common";

/** `record note "<text>"`: a user-visible step boundary; codegen writes it as a comment above the next step. */
export async function recordNote(session: OpSession, params: { text: string }): OpOutcome<RecordNoted> {
	const active = activeRecording(session);
	if (!active.success) return active;
	const note = params.text.trim();
	if (note === "") return failed("usage", "record note needs some text");
	const appended = await journalStore.appendStep(active.data.journal, {
		kind: "note",
		at: session.host.now(),
		text: note,
	});
	if (!appended.success) return journalFailure(appended.error);
	return resultFactory.ok({
		result: { outcome: "noted", step: appended.data.i, text: note },
		text: `noted as step ${appended.data.i}`,
	});
}

/** `record undo [n]`: drop the last `n` steps (default 1; notes count) from the journal. */
export async function recordUndo(session: OpSession, params: { count?: number } = {}): OpOutcome<RecordUndone> {
	const active = activeRecording(session);
	if (!active.success) return active;
	const n = params.count ?? 1;
	if (!Number.isInteger(n) || n < 1) return failed("usage", `undo count must be a positive integer, got "${n}"`);
	const removed = await journalStore.undoSteps(active.data.journal, n);
	if (!removed.success) {
		return journalFailure(
			removed.error,
			removed.error.code === "nothing_to_undo" ? "the recording is empty" : undefined
		);
	}
	const left = journalStore.readJournal(active.data.journal);
	const steps = left.success ? left.data.steps.length : null;
	const summaries = removed.data.map((step) => ({ i: step.i, summary: recordingStatusReader.summarizeStep(step) }));
	return resultFactory.ok({
		result: { outcome: "undone", removed: summaries, steps },
		text: [
			`removed ${summaries.length} step${summaries.length === 1 ? "" : "s"}${steps === null ? "" : `, ${steps} left`}`,
			...summaries.map((step) => `  - ${step.i} ${step.summary}`),
		].join("\n"),
	});
}

/** `record status`: the target, the step count, the last five steps and the lints so far. */
export async function recordStatus(session: OpSession): OpOutcome<RecordStatus | RecordIdle> {
	const pointer = session.state.read().recording;
	if (!pointer) return resultFactory.ok({ result: { outcome: "idle", recording: null }, text: "not recording" });
	const journal = journalStore.readJournal(journalOf(session));
	if (!journal.success) return journalFailure(journal.error, "`warden ui record cancel` clears it");
	const status = recordingStatusReader.recordingStatus(journal.data);
	return resultFactory.ok({
		result: {
			outcome: "recording",
			recording: {
				name: status.name,
				title: status.title ?? null,
				kind: pointer.target.kind,
				target: targetPath(pointer.target),
				startedAt: pointer.startedAt,
				steps: status.steps,
				last: status.last,
				lints: status.lints,
			},
		},
		text: [
			`recording "${status.name}" → ${targetPath(pointer.target)}: ${status.steps} step${status.steps === 1 ? "" : "s"}`,
			...status.last.map((step) => `  ${step.i} ${step.summary}`),
			...lintLines(status.lints, colorOf(session)),
		].join("\n"),
	});
}

/** `record cancel`: throw the journal away. A spec already written by a failed `stop` is left in place. */
export async function recordCancel(session: OpSession): OpOutcome<RecordCancelled> {
	const active = activeRecording(session);
	if (!active.success) return active;
	const { pointer, journal } = active.data;
	const read = journalStore.readJournal(journal);
	const steps = read.success ? read.data.steps.length : null;
	if (existsSync(journal)) journalStore.deleteJournal(journal);
	clearPointer(session);
	const kept = pointer.wrote === true ? pointer.target.path : undefined;
	return resultFactory.ok({
		result: { outcome: "cancelled", name: pointer.name, steps, ...(kept !== undefined ? { kept } : {}) },
		text: `cancelled "${pointer.name}"${steps === null ? "" : ` (${steps} steps dropped)`}${kept !== undefined ? `; ${kept} was already written and is left in place` : ""}`,
	});
}
