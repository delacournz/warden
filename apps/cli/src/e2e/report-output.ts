import { basename, isAbsolute, relative } from "node:path";
import type { TestResult, TestStatus } from "@delacour/warden-e2e/runner/results";
import type { E2eReport } from "../commands/e2e";
import type { SpecVerdict, TestVerdict } from "./verdicts";

/** `(path:line:col)` / `at path:line:col` in one stack frame. */
const FRAME = /\(?([^\s()]+):(\d+):\d+\)?\s*$/;

/**
 * The line in `file` where a test failed: the first stack frame in the spec file itself, past
 * warden's own frames and the helpers it called. Undefined when the spec is not on the stack.
 */
export function specLine(stack: string | undefined, file: string): number | undefined {
	if (!stack) return undefined;
	const name = basename(file);
	for (const raw of stack.split("\n")) {
		const match = FRAME.exec(raw.trim());
		const [, path, line] = match ?? [];
		if (path === undefined || line === undefined) continue;
		if (path === file || basename(path) === name) return Number(line);
	}
	return undefined;
}

const failing = (t: TestVerdict): boolean => t.status === "failed" || t.status === "timed-out";
const firstLine = (text: string | undefined): string => text?.split("\n")[0]?.trim() ?? "";

export type TestTotals = { passed: number; failed: number; skipped: number; specsPassed: number; specs: number };

/** Tests by outcome over every spec's last attempt (timed-out counts as failed), plus specs passed. */
export function testTotals(report: E2eReport): TestTotals {
	const tests = report.specs.flatMap((s) => s.tests ?? []);
	return {
		passed: tests.filter((t) => t.status === "passed").length,
		failed: tests.filter(failing).length,
		skipped: tests.filter((t) => t.status === "skipped").length,
		specsPassed: report.specs.filter((s) => s.verdict === "passed").length,
		specs: report.specs.length,
	};
}

export type CommonFailure = { message: string; count: number; of: number };

/** The first error line most failed tests share, when two or more share it: usually the root cause. */
export function commonFailure(report: E2eReport): CommonFailure | undefined {
	const messages = report.specs
		.flatMap((s) => s.tests ?? [])
		.filter(failing)
		.map((t) => firstLine(t.error))
		.filter((m) => m !== "");
	const counts = new Map<string, number>();
	for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
	const [top] = [...counts].sort((a, b) => b[1] - a[1]);
	if (!top || top[1] < 2) return undefined;
	return { message: top[0], count: top[1], of: messages.length };
}

export type GithubTarget = { root: string; summary?: string };

/** Under GitHub Actions: the workspace annotations are relative to and the step summary file. */
export function githubTarget(env: Readonly<Record<string, string | undefined>>): GithubTarget | undefined {
	if (env.GITHUB_ACTIONS !== "true") return undefined;
	return {
		root: env.GITHUB_WORKSPACE ?? "",
		...(env.GITHUB_STEP_SUMMARY ? { summary: env.GITHUB_STEP_SUMMARY } : {}),
	};
}

/** Workflow-command message escaping (`%`, CR, LF). */
const escapeData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** Workflow-command property escaping: data escaping plus `:` and `,`. */
const escapeProperty = (s: string): string => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

const repoPath = (file: string, root: string): string =>
	root !== "" && isAbsolute(file) && !relative(root, file).startsWith("..") ? relative(root, file) : file;

function command(level: "error" | "warning", props: { file: string; line?: number; title: string }, message: string) {
	const parts = [
		`file=${escapeProperty(props.file)}`,
		...(props.line !== undefined ? [`line=${props.line}`] : []),
		`title=${escapeProperty(props.title)}`,
	];
	return `::${level} ${parts.join(",")}::${escapeData(message)}`;
}

/**
 * GitHub annotations: one per failed test, on its spec file at the line it failed (`TestVerdict.line`),
 * and one per failed spec that reported no tests (it crashed or never started). A required spec is an
 * `error`, an optional one a `warning`.
 */
export function annotations(report: E2eReport, root: string): string[] {
	return report.specs.filter((s) => s.verdict === "failed").flatMap((spec) => specAnnotations(spec, root));
}

function specAnnotations(spec: SpecVerdict, root: string): string[] {
	const level = spec.required ? "error" : "warning";
	const file = repoPath(spec.file, root);
	const failed = (spec.tests ?? []).filter(failing);
	if (failed.length === 0) {
		const title = `${spec.id} failed${spec.required ? "" : " (optional)"}`;
		return [command(level, { file, title }, `no test results${spec.log ? ` — log ${spec.log}` : ""}`)];
	}
	return failed.map((t) => {
		const title = [spec.id, ...t.title].join(" › ");
		return command(level, { file, ...(t.line !== undefined ? { line: t.line } : {}), title }, t.error ?? t.status);
	});
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const ICON: Record<TestStatus, string> = { passed: "✅", failed: "❌", "timed-out": "⏱️", skipped: "⏭️" };

function rows(spec: SpecVerdict): string[] {
	const name = cell(`${spec.id}${spec.required ? "" : " (optional)"}`);
	const failed = (spec.tests ?? []).filter(failing);
	if (failed.length > 0)
		return failed.map(
			(t) =>
				`| ${ICON[t.status]} | ${name} | ${cell(t.title.join(" › "))} | ${secs(t.durationMs)} | ${cell(firstLine(t.error))} |`
		);
	const why = spec.verdict === "not-run" ? "(not run)" : "(no test results)";
	return [`| ⚠️ | ${name} | ${why} | | ${spec.log ? `log \`${spec.log}\`` : ""} |`];
}

/** Markdown for `$GITHUB_STEP_SUMMARY`: the gate, totals, the shared failure, then a row per failed test. */
export function stepSummary(report: E2eReport): string {
	const totals = testTotals(report);
	const gate = report.ok ? "✅" : "❌";
	const lines = [
		`### ${gate} warden e2e \`${report.suite}\` (${report.platform}): gate ${report.ok ? "passed" : "failed"}`,
		"",
		`${totals.specsPassed}/${totals.specs} spec(s) passed · tests: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`,
	];
	const common = commonFailure(report);
	if (common) lines.push("", `> ${common.count}/${common.of} failed tests share: \`${cell(common.message)}\``);
	const bad = report.specs.filter((s) => s.verdict !== "passed");
	if (bad.length > 0) lines.push("", "| | Spec | Test | Time | Error |", "|---|---|---|---|---|", ...bad.flatMap(rows));
	if (report.batchDir) lines.push("", `Batch dir: \`${report.batchDir}\``);
	return `${lines.join("\n")}\n`;
}

/** One `--json-lines` event: a test as it finishes, then the whole report once the run is over. */
export type E2eEvent =
	| {
			event: "test";
			spec: string;
			file: string;
			title: string[];
			status: TestStatus;
			durationMs: number;
			error?: string;
			code?: string;
			/** the line in `file` where it failed */
			line?: number;
			artifacts?: string;
			device: { udid: string; name?: string };
	  }
	| { event: "report"; report: E2eReport };

/** A finished test as a `--json-lines` event. */
export function testEvent(specId: string, result: TestResult): E2eEvent {
	const line = specLine(result.error?.stack, result.file);
	return {
		event: "test",
		spec: specId,
		file: result.file,
		title: result.title,
		status: result.status,
		durationMs: result.durationMs,
		...(result.error ? { error: result.error.message } : {}),
		...(result.error?.code ? { code: result.error.code } : {}),
		...(line !== undefined ? { line } : {}),
		...(result.artifacts ? { artifacts: result.artifacts.dir } : {}),
		device: { udid: result.device.udid, ...(result.device.name ? { name: result.device.name } : {}) },
	};
}
