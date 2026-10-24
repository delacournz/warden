import type { Finding } from "../shared/findings.types";
import type { AndroidCrash } from "./android-crash";
import { formatFrame, type IpsCrash } from "./ips";

/** What `perf crashes` found, platform-neutral. */
export type CrashRecord = {
	kind: "crash" | "anr";
	process: string;
	/** `SIGSEGV` · `EXC_BAD_ACCESS (SIGSEGV)` · the exception line · the ANR subject */
	summary: string;
	at: string;
	firstAppFrame?: string;
	source: string;
};

export function iosCrashRecord(c: IpsCrash, source: string): CrashRecord {
	const exc = [c.exceptionType, c.signal ? `(${c.signal})` : undefined].filter(Boolean).join(" ");
	return {
		kind: "crash",
		process: c.processName,
		summary: exc || c.termination || "crash",
		at: c.atMs === undefined ? "" : new Date(c.atMs).toISOString(),
		...(c.firstAppFrame !== undefined ? { firstAppFrame: formatFrame(c.firstAppFrame) } : {}),
		source,
	};
}

export function androidCrashRecord(c: AndroidCrash): CrashRecord {
	return {
		kind: c.kind,
		process: c.process,
		summary: c.reason || c.signal || c.kind,
		at: c.at,
		...(c.firstAppFrame !== undefined ? { firstAppFrame: c.firstAppFrame } : {}),
		source: c.source,
	};
}

/** One critical `crash` / `anr` finding per record. */
export function crashFindings(records: readonly CrashRecord[]): Finding[] {
	return records.map((r): Finding => {
		const where = r.firstAppFrame === undefined ? "" : ` at ${r.firstAppFrame}`;
		const common = {
			severity: "critical" as const,
			costMs: 0,
			evidence: `${r.process} ${r.kind === "anr" ? "not responding" : "crashed"}${r.at ? ` at ${r.at}` : ""}: ${r.summary}${where} (${r.source})`,
			next: ["warden perf crashes --json", "warden perf logs --level E --since 5m"],
			process: r.process,
		};
		return r.kind === "anr"
			? {
					kind: "anr",
					...common,
					fix: "find what blocks the main thread: sync I/O, a long JS-to-native call, or lock contention",
				}
			: {
					kind: "crash",
					...common,
					fix: r.firstAppFrame
						? `start at ${r.firstAppFrame}`
						: "symbolicate the report to find the app frame (--symbolicate --dsym <path>)",
				};
	});
}
