import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Suite, SuiteError } from "@delacour/warden-core/affected/affected";
import { type JournalError, journalStore } from "@delacour/warden-e2e/authoring/journal";
import type { LintFinding } from "@delacour/warden-e2e/authoring/lint";
import type { WardenError, WardenErrorCode } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import { uiPaths } from "../paths";
import type { OpSession } from "../session";
import { type AuthoringColor, type AuthoringDeps, PLAIN } from "./deps";
import type { RecordingPointer } from "./pointer";

/** Shared helpers of the authoring ops: coded failures, the recording pointer, the journal path, file IO. */
export class AuthoringCommon {
	/** A failed `Result` over a coded authoring error. */
	failed(
		code: WardenErrorCode,
		message: string,
		extra: { hint?: string; details?: Record<string, unknown> } = {}
	): { success: false; error: WardenError } {
		return { success: false, error: opErrors.opError(code, message, extra) };
	}

	/** A journal failure as a {@link WardenError}; the journal's own code rides along in `details.code`. */
	journalFailure(error: JournalError, hint?: string): { success: false; error: WardenError } {
		return this.failed("failed", error.message, {
			details: { code: error.code },
			...(hint !== undefined ? { hint } : {}),
		});
	}

	targetPath(target: RecordingPointer["target"]): string {
		return target.kind === "spec" ? target.path : `${target.path}#${target.fn}`;
	}

	depsOf(session: OpSession): AuthoringDeps {
		return session.authoring ?? {};
	}

	colorOf(session: OpSession): AuthoringColor {
		return this.depsOf(session).color ?? PLAIN;
	}

	/** The journal of this device's recording (`<home>/ui/<udid>/recording.json`). */
	journalOf(session: OpSession): string {
		return uiPaths.recordingFile(session.host.home, session.device.id);
	}

	/** The recording in progress and its journal, or `no_recording`. */
	activeRecording(session: OpSession): Result<{ pointer: RecordingPointer; journal: string }, WardenError> {
		const pointer = session.state.read().recording;
		if (!pointer) return this.failed("no_recording", "not recording", { hint: 'warden ui record start "<name>"' });
		return resultFactory.ok({ pointer, journal: this.journalOf(session) });
	}

	/** Rewrite the recording pointer; a call with no recording changes nothing. */
	updatePointer(session: OpSession, change: (pointer: RecordingPointer) => RecordingPointer): void {
		session.state.update((current) =>
			current.recording ? { ...current, recording: change(current.recording) } : current
		);
	}

	/** Drop the recording pointer from the device state. */
	clearPointer(session: OpSession): void {
		session.state.update(({ recording: _done, ...rest }) => rest);
	}

	private async defaultFindSuite(session: OpSession, name: string | undefined): AsyncResult<Suite, SuiteError> {
		const { affectedService } = await import("@delacour/warden-core/affected/affected");
		return affectedService.findSuite(session.host.exec, session.host.cwd, name, undefined, session.host.env);
	}

	/** The suite the recording belongs to: the injected lookup, else the nearest warden config. */
	findSuiteOf(session: OpSession, name: string | undefined): AsyncResult<Suite, SuiteError> {
		const find = this.depsOf(session).findSuite;
		return find ? find(name) : this.defaultFindSuite(session, name);
	}

	readIfExists(path: string): string | undefined {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	}

	write(path: string, source: string): void {
		mkdirSync(dirname(path), { recursive: true });
		journalStore.writeFileAtomic(path, source);
	}

	/** The lint findings as human lines (a finding, then its hint dimmed). */
	lintLines(lints: readonly LintFinding[], color: AuthoringColor): string[] {
		return lints.flatMap((lint) => {
			const paint = lint.level === "error" ? color.red : color.yellow;
			return [
				`${paint(lint.level)} ${lint.code}${lint.step === null ? "" : ` (step ${lint.step})`}: ${lint.message}`,
				`  ${color.dim(lint.hint)}`,
			];
		});
	}
}

export const authoringCommon = new AuthoringCommon();
