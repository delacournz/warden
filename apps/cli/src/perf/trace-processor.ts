import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import {
	TRACE_PROCESSOR_VERSION,
	traceProcessorFileName,
	traceProcessorPin,
	traceProcessorUrl,
} from "@delacour/warden-perf/android/trace-processor.data";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";

/** Effects the download reaches the host through; tests inject fakes (never a real download). */
export type TraceProcessorDeps = {
	fetch: (url: string) => Promise<Response>;
	platform: string;
	arch: string;
	/** raw stderr write: the progress bar lives here so `--json` stdout stays clean */
	writeErr: (text: string) => void;
	now: () => number;
	/** which pinned artifact fits this host; tests swap in one whose hash matches their fake payload */
	pinFor: typeof traceProcessorPin;
};

export const defaultTraceProcessorDeps: TraceProcessorDeps = {
	fetch: (url) => fetch(url),
	platform: process.platform,
	arch: process.arch,
	writeErr: (text) => {
		process.stderr.write(text);
	},
	now: () => Date.now(),
	pinFor: traceProcessorPin,
};

export const INSTALL_HINT = "warden perf tools install trace-processor --yes";

/** `$WARDEN_HOME/tools/trace_processor_shell-<ver>`, or the file `WARDEN_TRACE_PROCESSOR` names. */
export function traceProcessorPath(ctx: Pick<CommandContext, "env">): string {
	const override = ctx.env.WARDEN_TRACE_PROCESSOR;
	if (override !== undefined && override !== "") return override;
	return join(wardenHome(ctx.env), "tools", traceProcessorFileName());
}

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;
const BAR_WIDTH = 24;
/** A rich terminal redraws at most this often. */
const REDRAW_MS = 100;

type Progress = {
	start: (total: number) => void;
	update: (done: number, total: number) => void;
	finish: (done: number, ms: number) => void;
};

/** stderr progress: a redrawn bar on a rich terminal; otherwise one start line and one done line. */
function progress(ctx: CommandContext, deps: TraceProcessorDeps, label: string): Progress {
	const rich = ctx.ui.rich;
	let lastDraw = 0;
	const t0 = deps.now();
	return {
		start: (total) => {
			if (!rich) deps.writeErr(`downloading ${label} (${mb(total)})\n`);
		},
		update: (done, total) => {
			if (!rich) return;
			const now = deps.now();
			if (now - lastDraw < REDRAW_MS && done < total) return;
			lastDraw = now;
			const frac = total > 0 ? Math.min(1, done / total) : 0;
			const filled = Math.round(frac * BAR_WIDTH);
			const secs = Math.max(0.001, (now - t0) / 1000);
			const bar = `${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}`;
			deps.writeErr(
				`\r${label} [${bar}] ${mb(done)}/${mb(total)} ${(frac * 100).toFixed(0)}% ${(done / MB / secs).toFixed(1)} MB/s`
			);
		},
		finish: (done, ms) => {
			deps.writeErr(`${rich ? "\n" : ""}downloaded ${label} (${mb(done)} in ${(ms / 1000).toFixed(1)}s)\n`);
		},
	};
}

const fail = (error: UiError): Result<never, UiError> => ({ success: false, error });

/**
 * Download the pinned prebuilt: streamed to a temp file beside the destination, sha256-checked, `chmod 755`,
 * then renamed into place, so a failed or tampered download never leaves a runnable file behind.
 */
export async function downloadTraceProcessor(
	ctx: CommandContext,
	deps: TraceProcessorDeps
): Promise<Result<{ path: string; bytes: number }, UiError>> {
	const pinned = deps.pinFor(deps.platform, deps.arch);
	if (pinned === undefined) {
		return fail(
			uiError("tool_missing", `no prebuilt trace_processor for ${deps.platform}-${deps.arch}`, {
				hint: "set WARDEN_TRACE_PROCESSOR to a trace_processor_shell binary",
			})
		);
	}
	const { pin } = pinned;
	const url = traceProcessorUrl(pin);
	const dest = join(wardenHome(ctx.env), "tools", traceProcessorFileName());
	const label = `trace_processor ${TRACE_PROCESSOR_VERSION}`;
	const tmp = `${dest}.${deps.now()}.tmp`;
	mkdirSync(dirname(dest), { recursive: true });

	let fd: number | undefined;
	try {
		const res = await deps.fetch(url);
		if (!res.ok || res.body === null) {
			return fail(
				uiError("tool_missing", `GET ${url} → HTTP ${res.status}`, { hint: "retry, or set WARDEN_TRACE_PROCESSOR" })
			);
		}
		const total = Number(res.headers.get("content-length")) || pin.bytes;
		const bar = progress(ctx, deps, label);
		bar.start(total);
		const hash = createHash("sha256");
		fd = openSync(tmp, "w", 0o755);
		let done = 0;
		const started = deps.now();
		const reader = res.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			hash.update(chunk.value);
			writeSync(fd, chunk.value);
			done += chunk.value.byteLength;
			bar.update(done, total);
		}
		closeSync(fd);
		fd = undefined;
		bar.finish(done, deps.now() - started);
		const actual = hash.digest("hex");
		if (actual !== pin.sha256) {
			rmSync(tmp, { force: true });
			return fail(
				uiError("tool_missing", `checksum mismatch for ${url}: expected ${pin.sha256}, got ${actual}`, {
					hint: "the download was corrupted or tampered with; nothing was installed",
				})
			);
		}
		chmodSync(tmp, 0o755);
		renameSync(tmp, dest);
		return ok({ path: dest, bytes: done });
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(tmp, { force: true });
		return fail(
			uiError(
				"tool_missing",
				`download of ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
				{
					hint: INSTALL_HINT,
				}
			)
		);
	}
}

/**
 * The `trace_processor_shell` to run: `WARDEN_TRACE_PROCESSOR`, else the cached pin. When missing, an
 * interactive run asks before downloading (`--yes` skips the question); a non-interactive one without `--yes`
 * fails with `tool_missing` and the install hint. Nothing is ever downloaded unasked.
 */
export async function resolveTraceProcessor(
	ctx: CommandContext,
	deps: TraceProcessorDeps,
	opts: { yes: boolean }
): Promise<Result<string, UiError>> {
	const path = traceProcessorPath(ctx);
	if (existsSync(path)) return ok(path);
	if (ctx.env.WARDEN_TRACE_PROCESSOR !== undefined && ctx.env.WARDEN_TRACE_PROCESSOR !== "") {
		return fail(uiError("tool_missing", `WARDEN_TRACE_PROCESSOR points at ${path}, which does not exist`));
	}
	const pinned = deps.pinFor(deps.platform, deps.arch);
	const missing = uiError("tool_missing", `trace_processor ${TRACE_PROCESSOR_VERSION} is not installed`, {
		hint: INSTALL_HINT,
	});
	if (!opts.yes) {
		if (!ctx.ui.interactive) return fail(missing);
		const size = pinned === undefined ? "~14 MB" : `~${Math.round(pinned.pin.bytes / MB)} MB`;
		const answer = await ctx.ui.confirm(`Download trace_processor ${TRACE_PROCESSOR_VERSION} (${size}) to ${path}?`);
		if (answer !== true) return fail(missing);
	}
	const got = await downloadTraceProcessor(ctx, deps);
	return got.success ? ok(got.data.path) : got;
}
