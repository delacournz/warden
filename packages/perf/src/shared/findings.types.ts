export const SEVERITIES = ["critical", "warn", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Lower sorts first: critical findings lead a report. */
export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** What each kind of finding carries beyond the common fields. Later phases add kinds here, one line each. */
type FindingExtras = {
	"slow-commit": { commitIndex: number };
	"slow-render": { component: string };
	"memo-defeated": { component: string };
	"context-cascade": { component: string };
	"parent-cascade": { component: string };
	"render-storm": { component: string; renders: number };
	"eager-mount": { component: string };
	"effect-chain": { component: string };
	startup: { method: "am-start" | "xctrace" | "approx"; runs: number };
	jank: { jankPct: number };
	hang: { atMs: number };
	"cpu-hot": { thread: string; cpuPct: number };
	"memory-growth": { slopeKbPerSec: number };
	leak: { type: string; count: number };
	crash: { process: string };
	anr: { process: string };
	"js-hotspot": { file: string; line: number };
};

export type FindingKind = keyof FindingExtras;

export const FINDING_KINDS: readonly FindingKind[] = [
	"slow-commit",
	"slow-render",
	"memo-defeated",
	"context-cascade",
	"parent-cascade",
	"render-storm",
	"eager-mount",
	"effect-chain",
	"startup",
	"jank",
	"hang",
	"cpu-hot",
	"memory-growth",
	"leak",
	"crash",
	"anr",
	"js-hotspot",
];

type FindingCommon<K extends FindingKind> = {
	kind: K;
	severity: Severity;
	/** time the problem costs the user, in ms (0 when it is not a duration) */
	costMs: number;
	evidence: string;
	fix: string;
	/** follow-up `warden perf …` commands */
	next: string[];
};

/** One thing a report found. Discriminated on `kind`. */
export type Finding = { [K in FindingKind]: FindingCommon<K> & FindingExtras[K] }[FindingKind];
