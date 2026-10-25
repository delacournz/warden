import type { Manifest } from "../results/manifest";
import {
	type BenchRun,
	CANONICAL_IDS,
	type CanonicalId,
	type FrameworkResult,
	type ProcessRow,
} from "../results/schema";
import { bytes, cpuSeconds, DASH, ms, signedCpuSeconds, signedMs, signedPct } from "./format";
import { cpuSecondsPerRep, hasWarmRep, processesPerRep } from "./tables";

type FrameworkKey = FrameworkResult["framework"];

/**
 * A before/after pair of host CPU-seconds per rep (warm median). `allReps` when either run had no warm rep
 * (`--runs 1`), so that side's figure is the median over all its reps, cold included.
 */
export type CpuDelta = { a: number; b: number; delta: number; deltaPct: number; allReps?: true };

/** A before/after pair of one duration (ms) with the change from `a` to `b`. */
export type Delta = { aMs: number; bMs: number; deltaMs: number; deltaPct: number };

export type TestDelta = { id: CanonicalId; delta: Delta };

/** A process label's before/after in the warm-median reps' per-process tables; a side without the label reads 0. */
export type ProcessDelta = {
	name: string;
	scope: "host" | "sim";
	aCpuSeconds: number;
	bCpuSeconds: number;
	deltaCpuSeconds: number;
	aRssPeakBytes: number;
	bRssPeakBytes: number;
};

/** Rows of the per-process diff per framework and scope (largest CPU on either side first). */
export const COMPARE_PROCESS_ROWS = 8;

export type FrameworkCompare = {
	framework: FrameworkKey;
	aStatus: FrameworkResult["status"];
	bStatus: FrameworkResult["status"];
	/** only when both runs have the framework `ok` with a finite warm suite median */
	suite?: Delta;
	/** host CPU-seconds per rep, only when both runs recorded per-rep resources */
	cpuSecondsPerRep?: CpuDelta;
	/** top per-process rows by name, only when both runs recorded a per-process table */
	processes?: ProcessDelta[];
	tests: TestDelta[];
};

export type StatusChange = { framework: FrameworkKey; from: FrameworkResult["status"]; to: FrameworkResult["status"] };

export type CompareResult = {
	a: { id: string; startedAt: string };
	b: { id: string; startedAt: string };
	frameworks: FrameworkCompare[];
	statusChanges: StatusChange[];
	onlyInA: FrameworkKey[];
	onlyInB: FrameworkKey[];
};

/** `a` → `b` as a delta; undefined unless both are finite and `a` is positive. */
export function delta(aMs: number, bMs: number): Delta | undefined {
	if (!Number.isFinite(aMs) || !Number.isFinite(bMs) || aMs <= 0) return undefined;
	const deltaMs = bMs - aMs;
	return { aMs, bMs, deltaMs, deltaPct: Math.round((deltaMs / aMs) * 1000) / 10 };
}

/** Diffs two per-process tables by `scope` + `name`; the `other` bucket is skipped (its content differs per run). */
export function processDeltas(a: readonly ProcessRow[], b: readonly ProcessRow[]): ProcessDelta[] {
	const key = (r: ProcessRow): string => `${r.scope}\0${r.name}`;
	const inA = new Map(a.filter((r) => r.name !== "other").map((r) => [key(r), r]));
	const inB = new Map(b.filter((r) => r.name !== "other").map((r) => [key(r), r]));
	return (["host", "sim"] as const).flatMap((scope) => {
		const keys = [...new Set([...inA.keys(), ...inB.keys()])].filter((k) => k.startsWith(`${scope}\0`));
		const rows = keys.map((k): ProcessDelta => {
			const ra = inA.get(k);
			const rb = inB.get(k);
			const name = (ra ?? rb)?.name ?? "";
			return {
				name,
				scope,
				aCpuSeconds: ra?.cpuSeconds ?? 0,
				bCpuSeconds: rb?.cpuSeconds ?? 0,
				deltaCpuSeconds: (rb?.cpuSeconds ?? 0) - (ra?.cpuSeconds ?? 0),
				aRssPeakBytes: ra?.rssPeakBytes ?? 0,
				bRssPeakBytes: rb?.rssPeakBytes ?? 0,
			};
		});
		rows.sort(
			(x, y) =>
				Math.max(y.aCpuSeconds, y.bCpuSeconds) - Math.max(x.aCpuSeconds, x.bCpuSeconds) || (x.name < y.name ? -1 : 1)
		);
		return rows.slice(0, COMPARE_PROCESS_ROWS);
	});
}

function compareOne(a: FrameworkResult, b: FrameworkResult): FrameworkCompare {
	const base: FrameworkCompare = { framework: a.framework, aStatus: a.status, bStatus: b.status, tests: [] };
	if (a.status !== "ok" || b.status !== "ok") return base;
	const suite = delta(a.stats.warmSuiteWall.median, b.stats.warmSuiteWall.median);
	const tests = CANONICAL_IDS.flatMap((id) => {
		const d = delta(a.stats.perTest[id]?.median ?? Number.NaN, b.stats.perTest[id]?.median ?? Number.NaN);
		return d ? [{ id, delta: d }] : [];
	});
	const ca = cpuSecondsPerRep(a);
	const cb = cpuSecondsPerRep(b);
	const cpu = ca !== undefined && cb !== undefined ? delta(ca, cb) : undefined;
	const allReps = !hasWarmRep(a) || !hasWarmRep(b);
	const pa = processesPerRep(a);
	const pb = processesPerRep(b);
	return {
		...base,
		...(suite ? { suite } : {}),
		...(pa !== undefined && pb !== undefined ? { processes: processDeltas(pa, pb) } : {}),
		...(cpu
			? {
					cpuSecondsPerRep: {
						a: cpu.aMs,
						b: cpu.bMs,
						delta: cpu.deltaMs,
						deltaPct: cpu.deltaPct,
						...(allReps ? { allReps: true as const } : {}),
					},
				}
			: {}),
		tests,
	};
}

/** Diffs two runs: per framework present in both (suite and per-test), status changes, and one-sided frameworks. */
export function compareRuns(a: BenchRun, b: BenchRun): CompareResult {
	const inB = new Map(b.frameworks.map((f) => [f.framework, f]));
	const inA = new Map(a.frameworks.map((f) => [f.framework, f]));
	const frameworks: FrameworkCompare[] = [];
	const statusChanges: StatusChange[] = [];
	for (const fa of a.frameworks) {
		const fb = inB.get(fa.framework);
		if (!fb) continue;
		frameworks.push(compareOne(fa, fb));
		if (fa.status !== fb.status) statusChanges.push({ framework: fa.framework, from: fa.status, to: fb.status });
	}
	return {
		a: { id: a.id, startedAt: a.startedAt },
		b: { id: b.id, startedAt: b.startedAt },
		frameworks,
		statusChanges,
		onlyInA: a.frameworks.filter((f) => !inB.has(f.framework)).map((f) => f.framework),
		onlyInB: b.frameworks.filter((f) => !inA.has(f.framework)).map((f) => f.framework),
	};
}

const row = (cols: readonly string[]): string => `| ${cols.join(" | ")} |`;

function deltaCols(d: Delta | undefined): string[] {
	return d ? [ms(d.aMs), ms(d.bMs), signedMs(d.deltaMs), signedPct(d.deltaPct)] : [DASH, DASH, DASH, DASH];
}

function suiteSection(result: CompareResult): string[] {
	const rows = result.frameworks.map((f) => row([f.framework, ...deltaCols(f.suite)]));
	return [
		"## Suite median (warm)",
		"",
		row(["Framework", "A", "B", "Delta", "Delta %"]),
		row(["---", "---", "---", "---", "---"]),
		...rows,
	];
}

function cpuSection(result: CompareResult): string[] {
	const measured = result.frameworks.flatMap((f) => (f.cpuSecondsPerRep ? [{ f, c: f.cpuSecondsPerRep }] : []));
	if (measured.length === 0) return [];
	return [
		"",
		"## Host CPU-seconds per rep (warm)",
		"",
		row(["Framework", "A", "B", "Delta", "Delta %"]),
		row(["---", "---", "---", "---", "---"]),
		...measured.map(({ f, c }) =>
			row([
				c.allReps ? `${f.framework} (all reps)` : f.framework,
				cpuSeconds(c.a),
				cpuSeconds(c.b),
				signedCpuSeconds(c.delta),
				signedPct(c.deltaPct),
			])
		),
		...(measured.some(({ c }) => c.allReps)
			? [
					"",
					"`(all reps)`: a run had no warm rep (`--runs 1`), so its figure is the median over every rep, cold included.",
				]
			: []),
	];
}

function processSection(result: CompareResult): string[] {
	const out: string[] = [];
	for (const f of result.frameworks.filter((x) => x.processes !== undefined && x.processes.length > 0)) {
		out.push(
			"",
			`## Where the CPU goes: ${f.framework}`,
			"",
			row(["Process", "Scope", "A CPU-s", "B CPU-s", "Delta", "A RSS peak", "B RSS peak"]),
			row(["---", "---", "---", "---", "---", "---", "---"]),
			...(f.processes ?? []).map((p) =>
				row([
					p.name,
					p.scope,
					cpuSeconds(p.aCpuSeconds),
					cpuSeconds(p.bCpuSeconds),
					signedCpuSeconds(p.deltaCpuSeconds),
					bytes(p.aRssPeakBytes),
					bytes(p.bRssPeakBytes),
				])
			)
		);
	}
	return out;
}

function testSection(result: CompareResult, manifest: Manifest): string[] {
	const out: string[] = [];
	for (const f of result.frameworks.filter((x) => x.tests.length > 0)) {
		out.push(
			"",
			`## Per-test: ${f.framework}`,
			"",
			row(["Test", "A", "B", "Delta", "Delta %"]),
			row(["---", "---", "---", "---", "---"]),
			...f.tests.map((t) => row([manifest.tests[t.id]?.title ?? t.id, ...deltaCols(t.delta)]))
		);
	}
	return out;
}

function listSection(title: string, lines: readonly string[]): string[] {
	return ["", `## ${title}`, "", ...(lines.length > 0 ? lines : ["None."])];
}

/** The comparison as markdown (A = baseline, B = candidate). Pure. */
export function renderCompareMarkdown(result: CompareResult, manifest: Manifest): string {
	const lines = [
		"# e2e framework benchmark — compare",
		"",
		`- **A:** \`${result.a.id}\` (${result.a.startedAt.slice(0, 10)})`,
		`- **B:** \`${result.b.id}\` (${result.b.startedAt.slice(0, 10)})`,
		"",
		...suiteSection(result),
		...cpuSection(result),
		...processSection(result),
		...testSection(result, manifest),
		...listSection(
			"Status changes",
			result.statusChanges.map((c) => `- **${c.framework}:** ${c.from} → ${c.to}`)
		),
		...listSection(
			"Only in A",
			result.onlyInA.map((f) => `- ${f}`)
		),
		...listSection(
			"Only in B",
			result.onlyInB.map((f) => `- ${f}`)
		),
	];
	return `${lines.join("\n")}\n`;
}
