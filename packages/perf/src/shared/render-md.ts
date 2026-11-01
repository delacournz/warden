import { type Finding, SEVERITY_ORDER } from "./findings.types";

export const SIMULATOR_BANNER = "simulator: compare relative, not absolute (host CPU and GPU, no thermal limits)";
export const DEV_BUILD_BANNER =
	"dev build (__DEV__): unminified JS plus the DevTools hook inflate JS and React costs; confirm on a release or profileable build";

export type ReportSection = { title: string; lines: string[] };

export type Report = {
	title: string;
	/** one-line warnings shown under the title (simulator, `__DEV__`, clamped duration) */
	banners: string[];
	summary: string[];
	findings: Finding[];
	sections: ReportSection[];
	/** follow-up commands, always printed last */
	next: string[];
};

export type RenderOptions = {
	/** total lines to emit, `next:` included; the body is cut to fit. Without it nothing is cut (`report.md`). */
	maxLines?: number;
};

export class MarkdownRenderer {
	private rankFindings(findings: readonly Finding[]): Finding[] {
		return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.costMs - a.costMs);
	}

	private findingLines(finding: Finding): string[] {
		const cost = finding.costMs > 0 ? ` (${Math.round(finding.costMs)}ms)` : "";
		return [`- [${finding.severity}] ${finding.kind}: ${finding.evidence}${cost}`, `  fix: ${finding.fix}`];
	}

	private bodyLines(report: Report): string[] {
		const lines = [`# ${report.title}`, ""];
		for (const banner of report.banners) lines.push(`> ${banner}`);
		if (report.banners.length > 0) lines.push("");
		lines.push(...report.summary);
		const findings = this.rankFindings(report.findings);
		if (findings.length > 0) lines.push("", "## Findings", ...findings.flatMap(this.findingLines.bind(this)));
		for (const section of report.sections) lines.push("", `## ${section.title}`, ...section.lines);
		return lines;
	}

	/**
	 * The report as markdown: title, banners, summary, findings (critical first, then by cost), sections, then a
	 * `next:` block. With `maxLines` the body is cut with a "more lines" marker so the whole output fits and
	 * every `next:` hint survives.
	 */
	renderMarkdown(report: Report, options: RenderOptions = {}): string {
		const next = report.next.length > 0 ? ["next:", ...report.next.map((hint) => `  ${hint}`)] : [];
		const body = this.bodyLines(report);
		const { maxLines } = options;
		if (maxLines === undefined || body.length + next.length <= maxLines) return [...body, ...next].join("\n");
		const room = Math.max(1, maxLines - next.length - 1);
		const cut = body.length - room;
		return [...body.slice(0, room), `... ${cut} more lines (see report.md)`, ...next].join("\n");
	}
}

export const markdownRenderer = new MarkdownRenderer();
