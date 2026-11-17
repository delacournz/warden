/**
 * Pure logic of the AX witness harness: how a reply to a `snapshot` is classified, the JSONL record shape, and how a
 * run is summarised into "did the XCUITest runner answer while warden-simd's readers were silent".
 */

export type Source = "simd" | "runner";

/** `silent`: the reader did not answer in time (the signal a wedge produces); `error`: any other failure. */
export type Outcome = "answered" | "silent" | "error";

export type WireReply = {
	ok: boolean;
	data?: { backend?: string; nodes?: number; fallback?: { from?: string; to?: string; reason?: string } };
	error?: { code?: string; message?: string };
};

/** What came back for one request: a parsed reply, or nothing before the client's own deadline. */
export type ReadResult = { kind: "reply"; reply: WireReply } | { kind: "client-timeout"; waitedMs: number };

/** Error codes that mean "the accessibility service did not answer", on either wire. */
export const SILENT_CODES: readonly string[] = [
	"E_TIMEOUT",
	"E_AX_UNAVAILABLE",
	"E_APP_NOT_RESPONDING",
	"CLIENT_TIMEOUT",
];

export type ReadRecord = {
	kind: "read";
	round: number;
	source: Source;
	/** ms since the run started, when the request was sent */
	tMs: number;
	latencyMs: number;
	outcome: Outcome;
	code?: string;
	message?: string;
	backend?: string;
	nodes?: number;
	/** simd answered from another backend than asked for (axbridge silent, host ax answered) */
	fallbackReason?: string;
	/** the runner refused because an earlier op still holds XCUITest: not an independent probe of the AX service */
	busy?: boolean;
};

export type NoteRecord = { kind: "note"; tMs: number; text: string };
export type RunRecord = ReadRecord | NoteRecord;

export function classify(result: ReadResult): {
	outcome: Outcome;
	code?: string;
	message?: string;
	backend?: string;
	nodes?: number;
	fallbackReason?: string;
	busy?: boolean;
} {
	if (result.kind === "client-timeout") {
		return { outcome: "silent", code: "CLIENT_TIMEOUT", message: `no reply in ${result.waitedMs} ms` };
	}
	const { reply } = result;
	if (reply.ok) {
		return {
			outcome: "answered",
			backend: reply.data?.backend,
			nodes: reply.data?.nodes,
			fallbackReason: reply.data?.fallback?.reason,
		};
	}
	const code = reply.error?.code ?? "E_UNKNOWN";
	const message = reply.error?.message?.slice(0, 200);
	return {
		outcome: SILENT_CODES.includes(code) ? "silent" : "error",
		code,
		message,
		...(message?.startsWith("runner busy") ? { busy: true } : {}),
	};
}

export type Tally = { total: number; answered: number; silent: number; error: number; busy: number };

export type Streak = {
	firstRound: number;
	lastRound: number;
	/** consecutive rounds in which simd was silent */
	reads: number;
	startMs: number;
	endMs: number;
	durationMs: number;
	runner: Tally;
	/** `unread`: the runner was not asked during the streak (it was down) */
	verdict: "answered" | "silent" | "mixed" | "unread";
};

/**
 * `witness-unread`: every streak fell while the runner was not up (still starting, or never started), so it says
 * nothing about the runner; with a runner that never started it is the closest a run gets to "both silent".
 */
export type Verdict = "no-simd-silence" | "witness-answers" | "witness-silent" | "witness-mixed" | "witness-unread";

/** When the runner came up, from the run's notes; `failed` is a runner that never got ready (xcodebuild exit, ceiling). */
export type RunnerStartup =
	| { status: "ready"; readyMs: number }
	| { status: "failed"; reason: string }
	| { status: "unknown" };

export const RUNNER_READY_NOTE = "runner ready";
export const RUNNER_FAILURE_PREFIX = "runner failure: ";

export type Summary = {
	rounds: number;
	simd: Tally & { fallbacks: number };
	runner: Tally;
	minStreak: number;
	streaks: Streak[];
	longestSimdSilenceMs: number;
	runnerStartup: RunnerStartup;
	verdict: Verdict;
};

const emptyTally = (): Tally => ({ total: 0, answered: 0, silent: 0, error: 0, busy: 0 });

function tally(reads: readonly ReadRecord[]): Tally {
	const t = emptyTally();
	for (const read of reads) {
		t.total++;
		t[read.outcome]++;
		if (read.busy) t.busy++;
	}
	return t;
}

function streakVerdict(runner: Tally): Streak["verdict"] {
	if (runner.total === 0) return "unread";
	if (runner.answered === runner.total) return "answered";
	if (runner.answered === 0) return "silent";
	return "mixed";
}

function runnerStartup(records: readonly RunRecord[]): RunnerStartup {
	for (const record of records) {
		if (record.kind !== "note") continue;
		if (record.text === RUNNER_READY_NOTE) return { status: "ready", readyMs: record.tMs };
		if (record.text.startsWith(RUNNER_FAILURE_PREFIX)) {
			return { status: "failed", reason: record.text.slice(RUNNER_FAILURE_PREFIX.length) };
		}
	}
	return { status: "unknown" };
}

/** Rounds in which simd was silent `minStreak` or more times in a row, each with what the runner answered meanwhile. */
export function summarize(records: readonly RunRecord[], minStreak = 3): Summary {
	const reads = records.filter((r): r is ReadRecord => r.kind === "read");
	const simd = reads.filter((r) => r.source === "simd");
	const runner = reads.filter((r) => r.source === "runner");
	const rounds = new Set(reads.map((r) => r.round)).size;
	const simdByRound = new Map(simd.map((r) => [r.round, r]));
	const runnerByRound = new Map(runner.map((r) => [r.round, r]));
	const roundNumbers = [...simdByRound.keys()].sort((a, b) => a - b);

	const streaks: Streak[] = [];
	let run: number[] = [];
	const flush = (): void => {
		if (run.length >= minStreak) {
			const first = simdByRound.get(run[0] as number) as ReadRecord;
			const last = simdByRound.get(run[run.length - 1] as number) as ReadRecord;
			const during = run.flatMap((round) => runnerByRound.get(round) ?? []);
			const runnerTally = tally(during);
			streaks.push({
				firstRound: first.round,
				lastRound: last.round,
				reads: run.length,
				startMs: first.tMs,
				endMs: last.tMs + last.latencyMs,
				durationMs: last.tMs + last.latencyMs - first.tMs,
				runner: runnerTally,
				verdict: streakVerdict(runnerTally),
			});
		}
		run = [];
	};
	for (const round of roundNumbers) {
		if ((simdByRound.get(round) as ReadRecord).outcome === "silent") run.push(round);
		else flush();
	}
	flush();

	let verdict: Verdict = "no-simd-silence";
	if (streaks.length > 0) {
		const verdicts = new Set(streaks.filter((s) => s.verdict !== "unread").map((s) => s.verdict));
		if (verdicts.size === 0) verdict = "witness-unread";
		else if (verdicts.size === 1 && verdicts.has("answered")) verdict = "witness-answers";
		else if (verdicts.size === 1 && verdicts.has("silent")) verdict = "witness-silent";
		else verdict = "witness-mixed";
	}
	return {
		rounds,
		simd: { ...tally(simd), fallbacks: simd.filter((r) => r.fallbackReason !== undefined).length },
		runner: tally(runner),
		minStreak,
		streaks,
		longestSimdSilenceMs: streaks.reduce((max, s) => Math.max(max, s.durationMs), 0),
		runnerStartup: runnerStartup(records),
		verdict,
	};
}

export function formatSummary(summary: Summary): string {
	const line = (name: string, t: Tally): string =>
		`${name.padEnd(7)} ${t.total} reads: ${t.answered} answered, ${t.silent} silent${t.busy > 0 ? ` (${t.busy} of them runner-busy)` : ""}, ${t.error} error`;
	const out = [
		line("simd", summary.simd) + (summary.simd.fallbacks > 0 ? ` (${summary.simd.fallbacks} via fallback)` : ""),
		line("runner", summary.runner),
	];
	if (summary.runnerStartup.status === "failed") out.push(`runner never ready: ${summary.runnerStartup.reason}`);
	if (summary.streaks.length === 0) out.push(`no simd silence of >= ${summary.minStreak} reads in a row`);
	for (const s of summary.streaks) {
		out.push(
			`simd silent ${s.reads} reads (rounds ${s.firstRound}-${s.lastRound}, ${(s.durationMs / 1000).toFixed(1)} s): ` +
				`runner ${s.verdict} (${s.runner.answered}/${s.runner.total} answered${s.runner.busy > 0 ? `, ${s.runner.busy} busy` : ""})`
		);
	}
	out.push(`verdict: ${summary.verdict}`);
	return out.join("\n");
}

/** Parses a JSONL run file back into records, skipping lines that are not records. */
export function parseJsonl(text: string): RunRecord[] {
	const out: RunRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value = JSON.parse(line) as { kind?: string };
			if (value.kind === "read" || value.kind === "note") out.push(value as RunRecord);
		} catch {
			// a torn last line
		}
	}
	return out;
}

const READY_PREFIX = "WARDEN_RUNNER_READY";

/** The listening port in a `WARDEN_RUNNER_READY {json}` line, or undefined for any other line. */
export function readyPort(line: string): number | undefined {
	const at = line.indexOf(READY_PREFIX);
	if (at < 0) return undefined;
	try {
		const port: unknown = JSON.parse(line.slice(at + READY_PREFIX.length).trim()).port;
		return typeof port === "number" ? port : undefined;
	} catch {
		return undefined;
	}
}

/** The frontmost app's pid and the SpringBoard pid from `launchctl list` output (`pid<TAB>status<TAB>label`). */
export function pidForLabel(launchctlList: string, labelSuffix: string): number | undefined {
	for (const line of launchctlList.split("\n")) {
		const [pid, , label] = line.split("\t");
		if (label?.trim().endsWith(labelSuffix)) {
			const n = Number(pid);
			return Number.isInteger(n) && n > 0 ? n : undefined;
		}
	}
	return undefined;
}
