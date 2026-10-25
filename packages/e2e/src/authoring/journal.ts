import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { ok, type Result } from "@delacour/warden-types/result";
import {
	type NewStep,
	RECORDING_VERSION,
	type RecordedStep,
	type Recording,
	recordingSchema,
} from "./recording.schema";

/**
 * The journal: one `recording.json` that `warden ui` appends to after every action, under a cross-process lock so
 * concurrent invocations keep a single, ordered history. Mistakes are fixed with `undoSteps`, a recording is thrown
 * away with `deleteJournal`, and codegen reads the finished file. Every write is a whole-file temp + rename.
 */

export type JournalErrorCode =
	| "journal_missing"
	| "journal_invalid"
	| "journal_exists"
	| "nothing_to_undo"
	| "bad_count"
	| "lock_timeout"
	| "io";
export type JournalError = { code: JournalErrorCode; message: string };

function journalError(code: JournalErrorCode, message: string): { success: false; error: JournalError } {
	return { success: false, error: { code, message } };
}

let tempCounter = 0;

/** Write through a sibling temp file + rename, so readers never see half a file. */
export function writeFileAtomic(path: string, content: string): void {
	tempCounter += 1;
	const temp = `${path}.${process.pid}.${tempCounter}.tmp`;
	writeFileSync(temp, content);
	renameSync(temp, path);
}

export function serializeRecording(recording: Recording): string {
	return `${JSON.stringify(recording, null, 2)}\n`;
}

export function parseRecording(raw: string): Result<Recording, JournalError> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return journalError("journal_invalid", "not valid JSON");
	}
	const parsed = recordingSchema.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
		return journalError("journal_invalid", `${issue?.message ?? "invalid recording"}${where}`);
	}
	return ok(parsed.data);
}

export function readJournal(file: string): Result<Recording, JournalError> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return journalError("journal_missing", `${file} does not exist`);
	}
	return parseRecording(raw);
}

export type WriteFile = (path: string, content: string) => void;

/** Start a recording: an empty journal, refusing to overwrite an existing file. */
export function createJournal(
	file: string,
	header: Pick<Recording, "name" | "createdAt" | "recordedOn"> & Partial<Pick<Recording, "title">>,
	options: { write?: WriteFile } = {}
): Result<Recording, JournalError> {
	if (existsSync(file)) return journalError("journal_exists", `${file} already exists`);
	const recording: Recording = { v: RECORDING_VERSION, ...header, steps: [] };
	try {
		mkdirSync(dirname(file), { recursive: true });
		(options.write ?? writeFileAtomic)(file, serializeRecording(recording));
	} catch (error) {
		return journalError("io", error instanceof Error ? error.message : String(error));
	}
	return ok(recording);
}

/** Throw the recording away: the journal (and a lock a dead process left) is removed. A missing file is `journal_missing`. */
export function deleteJournal(file: string): Result<true, JournalError> {
	if (!existsSync(file)) return journalError("journal_missing", `${file} does not exist`);
	try {
		unlinkSync(file);
	} catch (error) {
		return journalError("io", error instanceof Error ? error.message : String(error));
	}
	return ok(true);
}

export type AppendOptions = {
	/** the whole-file write; default is temp file + rename */
	write?: WriteFile;
	/** give up on the lock after this long. Default 5000. */
	timeoutMs?: number;
	/** a lock file older than this belongs to a dead process. Default 10000. */
	staleMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Lock = { release(): void };

type LockOptions = Required<Pick<AppendOptions, "timeoutMs" | "staleMs">> & Pick<AppendOptions, "sleep" | "now">;

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** Try to create the lock file exclusively: held, busy (someone else has it) or an I/O failure. */
function tryCreate(path: string): Result<Lock, JournalError> | "busy" {
	try {
		const fd = openSync(path, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
	} catch (error) {
		if (errnoCode(error) === "EEXIST") return "busy";
		return journalError("io", error instanceof Error ? error.message : String(error));
	}
	return ok({
		release() {
			try {
				unlinkSync(path);
			} catch {
				// already gone: nothing left to release
			}
		},
	});
}

/** Remove a lock whose holder died; false when the lock is fresh (or vanished, in which case just retry). */
function breakIfStale(path: string, staleMs: number): boolean {
	try {
		if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
		unlinkSync(path);
	} catch {
		// released between our open and stat: retry at once
	}
	return true;
}

/** `O_EXCL` lock file next to the journal: the only way two processes get to read-modify-write one at a time. */
async function acquire(file: string, options: LockOptions): Promise<Result<Lock, JournalError>> {
	const path = `${file}.lock`;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline = now() + options.timeoutMs;
	for (let attempt = 0; ; attempt += 1) {
		const created = tryCreate(path);
		if (created !== "busy") return created;
		if (breakIfStale(path, options.staleMs)) continue;
		if (now() >= deadline) return journalError("lock_timeout", `${path} is held by another process`);
		await sleep(2 + Math.floor(Math.random() * 8) + Math.min(attempt, 10));
	}
}

/**
 * Run `change` on the current recording under the journal lock and write what it returns (whole file, atomically).
 * `change` returns the new recording plus whatever the caller wants back, or an error that leaves the file untouched.
 */
async function mutate<T>(
	file: string,
	options: AppendOptions,
	change: (current: Recording) => Result<{ next: Recording; value: T }, JournalError>
): Promise<Result<T, JournalError>> {
	if (!existsSync(file)) return journalError("journal_missing", `${file} does not exist; run \`record start\` first`);
	const lock = await acquire(file, {
		timeoutMs: options.timeoutMs ?? 5000,
		staleMs: options.staleMs ?? 10_000,
		...(options.sleep && { sleep: options.sleep }),
		...(options.now && { now: options.now }),
	});
	if (!lock.success) return lock;
	try {
		const current = readJournal(file);
		if (!current.success) return current;
		const changed = change(current.data);
		if (!changed.success) return changed;
		const check = recordingSchema.safeParse(changed.data.next);
		if (!check.success) return journalError("journal_invalid", check.error.issues[0]?.message ?? "invalid step");
		(options.write ?? writeFileAtomic)(file, serializeRecording(changed.data.next));
		return ok(changed.data.value);
	} catch (error) {
		return journalError("io", error instanceof Error ? error.message : String(error));
	} finally {
		lock.data.release();
	}
}

/**
 * Append one step. Under the lock: read the current recording, number the step (`i` = steps so far, so concurrent
 * recorders never collide), rewrite the whole file. Returns the numbered step.
 */
export function appendStep(
	file: string,
	step: NewStep,
	options: AppendOptions = {}
): Promise<Result<RecordedStep, JournalError>> {
	return mutate(file, options, (current) => {
		// spreading a `NewStep` union widens it past `RecordedStep`; `mutate` re-validates the whole recording before
		// anything is written, so the assertion cannot let a malformed step through
		const numbered = { ...step, i: current.steps.length } as RecordedStep;
		return ok({ next: { ...current, steps: [...current.steps, numbered] }, value: numbered });
	});
}

/** Drop the last `count` steps (notes included), clamped to what there is. Returns the removed steps, oldest first. */
export function undoSteps(
	file: string,
	count = 1,
	options: AppendOptions = {}
): Promise<Result<RecordedStep[], JournalError>> {
	return mutate(file, options, (current) => {
		if (!Number.isInteger(count) || count < 1)
			return journalError("bad_count", "undo count must be a positive integer");
		if (current.steps.length === 0) return journalError("nothing_to_undo", "the recording has no steps");
		const keep = Math.max(0, current.steps.length - count);
		return ok({
			next: { ...current, steps: current.steps.slice(0, keep) },
			value: current.steps.slice(keep),
		});
	});
}

/**
 * The seam `warden ui` actions call after every action while a recording is active. A fresh recorder per invocation
 * is fine: all ordering lives in the file lock, not in the object.
 */
export type JournalRecorder = {
	append(step: NewStep): Promise<Result<RecordedStep, JournalError>>;
};

export function createJournalRecorder(file: string, options: AppendOptions = {}): JournalRecorder {
	return { append: (step) => appendStep(file, step, options) };
}
