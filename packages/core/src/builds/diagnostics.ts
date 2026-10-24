/** One error the compiler or linker reported; `file`/`line`/`column` are absent for errors without a source location. */
export type BuildDiagnostic = { file?: string; line?: number; column?: number; message: string };

const LOCATED = /^(\/[^\n]*?):(\d+):(\d+): (?:fatal )?error: (.+)$/;
const UNLOCATED = /^(?:[\w+.-]+: )?(?:fatal )?error: (.+)$/;

/**
 * Errors in `xcodebuild` / `swiftc` / `clang` output: `/path/File.swift:12:5: error: message` (Xcode's diagnostic
 * format), and location-less `error:` lines (linker, signing). Repeats (the failure summary at the end) are
 * dropped, and so are warnings and source excerpts. Parsing the log is the route when the build is `expo run:ios`,
 * which does not expose an `-resultBundlePath`.
 */
export function parseBuildDiagnostics(output: string): BuildDiagnostic[] {
	const seen = new Set<string>();
	const found: BuildDiagnostic[] = [];
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		const located = LOCATED.exec(line);
		const diagnostic: BuildDiagnostic | undefined = located
			? { file: located[1] ?? "", line: Number(located[2]), column: Number(located[3]), message: located[4] ?? "" }
			: unlocated(line);
		if (!diagnostic || seen.has(line)) continue;
		seen.add(line);
		found.push(diagnostic);
	}
	return found;
}

function unlocated(line: string): BuildDiagnostic | undefined {
	const message = UNLOCATED.exec(line)?.[1];
	return message === undefined ? undefined : { message };
}

function where(d: BuildDiagnostic): string {
	return d.file === undefined ? "" : `${d.file}:${d.line}:${d.column}: `;
}

/** `N errors: file:line:col: msg; … (+K more) — full log: path`; undefined when nothing was parsed. */
export function formatBuildFailure(
	diagnostics: readonly BuildDiagnostic[],
	logPath: string | undefined,
	show = 5
): string | undefined {
	if (diagnostics.length === 0) return undefined;
	const head = diagnostics.slice(0, show).map((d) => `${where(d)}${d.message}`);
	const more = diagnostics.length > show ? ` (+${diagnostics.length - show} more)` : "";
	const noun = diagnostics.length === 1 ? "error" : "errors";
	const log = logPath === undefined ? "" : ` — full log: ${logPath}`;
	return `${diagnostics.length} ${noun}: ${head.join("; ")}${more}${log}`;
}
