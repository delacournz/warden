/** A flow finished inside a `mode: "single"` runner, read off the runner's output. */
export type FlowMark = "passed" | "failed";

/** A flow to look for: `path` as the runner prints it (relative to the runner's cwd). */
export type TrackedFlow = { id: string; path: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g;
const FAILURE = /\b(failed|interrupted|timed out|error)\b/i;

/** `line` names `path` as a whole token (preceded by start / space / `|`, followed by end / space / `:`). */
function names(line: string, path: string): boolean {
	let at = line.indexOf(path);
	while (at !== -1) {
		const before = at === 0 ? " " : line[at - 1];
		const after = line[at + path.length] ?? " ";
		if ((before === " " || before === "|") && (after === " " || after === ":")) return true;
		at = line.indexOf(path, at + 1);
	}
	return false;
}

/** The mark a file-level line gives: `✓` passed; `×` / `✗`, or `❯` with a failure count, failed. */
function markOf(line: string): FlowMark | undefined {
	const head = line.trimStart();
	if (head.startsWith("✓")) return "passed";
	if (head.startsWith("×") || head.startsWith("✗")) return "failed";
	if (head.startsWith("❯") && FAILURE.test(head)) return "failed";
	return undefined;
}

/**
 * Per-flow results so far, from the output of one runner that runs every flow (tester.army
 * `e2e run`'s list reporter: ` ✓ |ios| e2e/a.e2e.ts (1 test) 6.8s`, ` ❯ |ios| e2e/b.e2e.ts (3 tests | 1 failed)`).
 * Only lines that name a flow's file count, so per-test lines under a file never do. The last line
 * for a flow wins (retries). Flows not finished yet are absent.
 */
export function flowMarks(output: string, flows: readonly TrackedFlow[]): Record<string, FlowMark> {
	const marks: Record<string, FlowMark> = {};
	for (const raw of output.split("\n")) {
		const line = raw.replace(ANSI, "");
		const mark = markOf(line);
		if (!mark) continue;
		const flow = flows.find((f) => names(line, f.path));
		if (flow) marks[flow.id] = mark;
	}
	return marks;
}
