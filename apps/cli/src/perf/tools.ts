import { existsSync, statSync } from "node:fs";
import type { Command as Commander } from "@commander-js/extra-typings";
import { TRACE_PROCESSOR_VERSION } from "@delacour/warden-perf/android/trace-processor.data";
import { reportError, UI_EXIT, type UiExitCode, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { PerfRegister } from "./register";
import {
	defaultTraceProcessorDeps,
	resolveTraceProcessor,
	type TraceProcessorDeps,
	traceProcessorPath,
} from "./trace-processor";

export type PerfToolsInstallOptions = { yes?: boolean; json?: boolean };

/** The tools `warden perf tools install` knows. */
export const PERF_TOOLS = ["trace-processor"] as const;

/**
 * `warden perf tools install trace-processor [--yes]`: fetch the pinned Perfetto `trace_processor_shell` into
 * `$WARDEN_HOME/tools/`. Asks first on a terminal; without a terminal it needs `--yes`. The progress bar is on
 * stderr, so `--json` stdout stays one document.
 */
export async function perfToolsInstall(
	ctx: CommandContext,
	deps: TraceProcessorDeps,
	tool: string,
	opts: PerfToolsInstallOptions
): Promise<UiExitCode> {
	const json = opts.json === true;
	const report = { command: "tools install", label: "perf tools install", json, startedAt: ctx.now() };
	if (tool !== "trace-processor") {
		return reportError(ctx, report, uiError("usage", `unknown tool "${tool}" (known: ${PERF_TOOLS.join(", ")})`));
	}
	const path = traceProcessorPath(ctx);
	const had = existsSync(path);
	const resolved = await resolveTraceProcessor(ctx, deps, { yes: opts.yes === true });
	if (!resolved.success) return reportError(ctx, report, resolved.error);
	const bytes = statSync(resolved.data).size;
	const result = { tool, version: TRACE_PROCESSOR_VERSION, path: resolved.data, bytes, downloaded: !had };
	if (json) {
		ctx.out(JSON.stringify({ ok: true, command: report.command, durationMs: ctx.now() - report.startedAt, result }));
	} else {
		ctx.out(
			`${ctx.ui.color.green(had ? "already installed" : "installed")} trace_processor ${TRACE_PROCESSOR_VERSION} ${ctx.ui.color.dim(resolved.data)}`
		);
	}
	return UI_EXIT.ok;
}

/** Wire `tools` onto `warden perf`. */
export const registerTools: PerfRegister = (cmd: Commander, ctx, done) => {
	const tools = cmd.command("tools").description("install the helper binaries profiling needs");
	tools
		.command("install")
		.description("download a pinned helper (trace-processor: Perfetto's trace_processor_shell, ~14 MB, sha256-checked)")
		.argument("<tool>", `which helper (${PERF_TOOLS.join(" | ")})`)
		.option("-y, --yes", "download without asking")
		.option("--json", "machine-readable output")
		.action(async (tool, opts) => {
			done(await perfToolsInstall(ctx, defaultTraceProcessorDeps, tool, opts));
		});
};
