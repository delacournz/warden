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
import { type Result, resultFactory } from "@delacour/warden-types/result";
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

export type WriteFile = (path: string, content: string) => void;

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

type Lock = { release(): void };

type LockOptions = Required<Pick<AppendOptions, "timeoutMs" | "staleMs">> & Pick<AppendOptions, "sleep" | "now">;

/**
 * The seam `warden ui` actions call after every action while a recording is active. A fresh recorder per invocation
 * is fine: all ordering lives in the file lock, not in the object.
 */
export type JournalRecorder = {
	append(step: NewStep): Promise<Result<RecordedStep, JournalError>>;
};

export class JournalStore {
	private tempCounter = 0;

	private journalError(code: JournalErrorCode, message: string): { success: false; error: JournalError } {
		return { success: false, error: { code, message } };
	}

	/** Write through a sibling temp file + rename, so readers never see half a file. */
	writeFileAtomic(path: string, content: string): void {
		this.tempCounter += 1;
		const temp = `${path}.${process.pid}.${this.tempCounter}.tmp`;
		writeFileSync(temp, content);
		renameSync(temp, path);
	}

	serializeRecording(recording: Recording): string {
		return `${JSON.stringify(recording, null, 2)}\n`;
	}

	parseRecording(raw: string): Result<Recording, JournalError> {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return this.journalError("journal_invalid", "not valid JSON");
		}
		const parsed = recordingSchema.safeParse(json);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
			return this.journalError("journal_invalid", `${issue?.message ?? "invalid recording"}${where}`);
		}
		return resultFactory.ok(parsed.data);
	}

	readJournal(file: string): Result<Recording, JournalError> {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			return this.journalError("journal_missing", `${file} does not exist`);
		}
		return this.parseRecording(raw);
	}

	/** Start a recording: an empty journal, refusing to overwrite an existing file. */
	createJournal(
		file: string,
		header: Pick<Recording, "name" | "createdAt" | "recordedOn"> & Partial<Pick<Recording, "title">>,
		options: { write?: WriteFile } = {}
	): Result<Recording, JournalError> {
		if (existsSync(file)) return this.journalError("journal_exists", `${file} already exists`);
		const recording: Recording = { v: RECORDING_VERSION, ...header, steps: [] };
		try {
			mkdirSync(dirname(file), { recursive: true });
			(options.write ?? ((p, c) => this.writeFileAtomic(p, c)))(file, this.serializeRecording(recording));
		} catch (error) {
			return this.journalError("io", error instanceof Error ? error.message : String(error));
		}
		return resultFactory.ok(recording);
	}

	/** Throw the recording away: the journal (and a lock a dead process left) is removed. A missing file is `journal_missing`. */
	deleteJournal(file: string): Result<true, JournalError> {
		if (!existsSync(file)) return this.journalError("journal_missing", `${file} does not exist`);
		try {
			unlinkSync(file);
		} catch (error) {
			return this.journalError("io", error instanceof Error ? error.message : String(error));
		}
		return resultFactory.ok(true);
	}

	private errnoCode(error: unknown): string | undefined {
		return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	}

	/** Try to create the lock file exclusively: held, busy (someone else has it) or an I/O failure. */
	private tryCreate(path: string): Result<Lock, JournalError> | "busy" {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
		} catch (error) {
			if (this.errnoCode(error) === "EEXIST") return "busy";
			return this.journalError("io", error instanceof Error ? error.message : String(error));
		}
		return resultFactory.ok({
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
	private breakIfStale(path: string, staleMs: number): boolean {
		try {
			if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
			unlinkSync(path);
		} catch {
			// released between our open and stat: retry at once
		}
		return true;
	}

	/** `O_EXCL` lock file next to the journal: the only way two processes get to read-modify-write one at a time. */
	private async acquire(file: string, options: LockOptions): Promise<Result<Lock, JournalError>> {
		const path = `${file}.lock`;
		const now = options.now ?? Date.now;
		const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const deadline = now() + options.timeoutMs;
		for (let attempt = 0; ; attempt += 1) {
			const created = this.tryCreate(path);
			if (created !== "busy") return created;
			if (this.breakIfStale(path, options.staleMs)) continue;
			if (now() >= deadline) return this.journalError("lock_timeout", `${path} is held by another process`);
			await sleep(2 + Math.floor(Math.random() * 8) + Math.min(attempt, 10));
		}
	}

	/**
	 * Run `change` on the current recording under the journal lock and write what it returns (whole file, atomically).
	 * `change` returns the new recording plus whatever the caller wants back, or an error that leaves the file untouched.
	 */
	private async mutate<T>(
		file: string,
		options: AppendOptions,
		change: (current: Recording) => Result<{ next: Recording; value: T }, JournalError>
	): Promise<Result<T, JournalError>> {
		if (!existsSync(file))
			return this.journalError("journal_missing", `${file} does not exist; run \`record start\` first`);
		const lock = await this.acquire(file, {
			timeoutMs: options.timeoutMs ?? 5000,
			staleMs: options.staleMs ?? 10_000,
			...(options.sleep && { sleep: options.sleep }),
			...(options.now && { now: options.now }),
		});
		if (!lock.success) return lock;
		try {
			const current = this.readJournal(file);
			if (!current.success) return current;
			const changed = change(current.data);
			if (!changed.success) return changed;
			const check = recordingSchema.safeParse(changed.data.next);
			if (!check.success) return this.journalError("journal_invalid", check.error.issues[0]?.message ?? "invalid step");
			(options.write ?? ((p, c) => this.writeFileAtomic(p, c)))(file, this.serializeRecording(changed.data.next));
			return resultFactory.ok(changed.data.value);
		} catch (error) {
			return this.journalError("io", error instanceof Error ? error.message : String(error));
		} finally {
			lock.data.release();
		}
	}

	/**
	 * Append one step. Under the lock: read the current recording, number the step (`i` = steps so far, so concurrent
	 * recorders never collide), rewrite the whole file. Returns the numbered step.
	 */
	appendStep(file: string, step: NewStep, options: AppendOptions = {}): Promise<Result<RecordedStep, JournalError>> {
		return this.mutate(file, options, (current) => {
			// spreading a `NewStep` union widens it past `RecordedStep`; `mutate` re-validates the whole recording before
			// anything is written, so the assertion cannot let a malformed step through
			const numbered = { ...step, i: current.steps.length } as RecordedStep;
			return resultFactory.ok({ next: { ...current, steps: [...current.steps, numbered] }, value: numbered });
		});
	}

	/** Drop the last `count` steps (notes included), clamped to what there is. Returns the removed steps, oldest first. */
	undoSteps(file: string, count = 1, options: AppendOptions = {}): Promise<Result<RecordedStep[], JournalError>> {
		return this.mutate(file, options, (current) => {
			if (!Number.isInteger(count) || count < 1)
				return this.journalError("bad_count", "undo count must be a positive integer");
			if (current.steps.length === 0) return this.journalError("nothing_to_undo", "the recording has no steps");
			const keep = Math.max(0, current.steps.length - count);
			return resultFactory.ok({
				next: { ...current, steps: current.steps.slice(0, keep) },
				value: current.steps.slice(keep),
			});
		});
	}

	createJournalRecorder(file: string, options: AppendOptions = {}): JournalRecorder {
		return { append: (step) => this.appendStep(file, step, options) };
	}
}

export const journalStore = new JournalStore();
