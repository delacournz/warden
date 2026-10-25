import { readFileSync, statSync } from "node:fs";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { type BenchRun, type FrameworkResult, frameworkIdSchema, type OkFrameworkResult } from "../results/schema";
import { median } from "../results/stats";
import { readBenchResults } from "../results/write";
import { cpuSecondsPerRep } from "./tables";

type FrameworkKey = FrameworkResult["framework"];

/** The two numbers the CPU regression guard watches, per framework. Either may be absent (older results). */
export type GuardMetrics = { cpuSecondsPerRep?: number; rssPeakBytes?: number };

/** One side of a guarded compare: a run dir reduced to its guarded numbers, or a committed baseline file. */
export type GuardSide = {
	id: string;
	startedAt: string;
	metrics: Partial<Record<FrameworkKey, GuardMetrics>>;
};

/**
 * Host RSS peak of the timed `run` window, median over the warm reps (all reps when none is warm), the same
 * reps the CPU headline draws from. Undefined when no rep recorded resources.
 */
export function rssPeakPerRep(f: OkFrameworkResult): number | undefined {
	const warm = f.reps.filter((r) => !r.cold);
	const values = (warm.length > 0 ? warm : f.reps).flatMap((r) => (r.resources ? [r.resources.rssPeakBytes] : []));
	return values.length > 0 ? median(values) : undefined;
}

/** A run reduced to the guarded numbers of its ok frameworks. */
export function sideOfRun(run: BenchRun): GuardSide {
	const metrics: GuardSide["metrics"] = {};
	for (const f of run.frameworks) {
		if (f.status !== "ok") continue;
		const cpu = cpuSecondsPerRep(f);
		const rss = rssPeakPerRep(f);
		metrics[f.framework] = {
			...(cpu !== undefined ? { cpuSecondsPerRep: cpu } : {}),
			...(rss !== undefined ? { rssPeakBytes: rss } : {}),
		};
	}
	return { id: run.id, startedAt: run.startedAt, metrics };
}

/**
 * The smallest file `bench compare` accepts as a side: committed under `baselines/`, built from one run's
 * summary. `warmSuiteMedianMs` is informational (the guard does not read it).
 */
export const baselineSchema = z.object({
	baselineVersion: z.literal(1),
	id: z.string(),
	startedAt: z.string(),
	platform: z.enum(["ios", "android"]),
	frameworks: z.array(
		z.object({
			framework: frameworkIdSchema,
			cpuSecondsPerRep: z.number().optional(),
			rssPeakBytes: z.number().optional(),
			warmSuiteMedianMs: z.number().optional(),
		})
	),
});

/** Parses a baseline file's text into a guard side; the issues as one string on failure. */
export function parseBaseline(text: string): Result<GuardSide> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return err(`not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = baselineSchema.safeParse(json);
	if (!parsed.success) {
		return err(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
	}
	const metrics: GuardSide["metrics"] = {};
	for (const f of parsed.data.frameworks) {
		metrics[f.framework] = {
			...(f.cpuSecondsPerRep !== undefined ? { cpuSecondsPerRep: f.cpuSecondsPerRep } : {}),
			...(f.rssPeakBytes !== undefined ? { rssPeakBytes: f.rssPeakBytes } : {}),
		};
	}
	return ok({ id: parsed.data.id, startedAt: parsed.data.startedAt, metrics });
}

/** `run` is set only for a run dir: a baseline file has nothing to render a full diff from. */
export type LoadedSide = { side: GuardSide; run?: BenchRun };

/** Loads a run dir (`bench-results.json`) or, when `path` is a file, a baseline file. */
export function loadGuardSide(path: string): Result<LoadedSide> {
	let isFile: boolean;
	try {
		isFile = statSync(path).isFile();
	} catch (e) {
		return err(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isFile) {
		const run = readBenchResults(path);
		return run.success ? ok({ side: sideOfRun(run.data), run: run.data }) : err(run.error);
	}
	const parsed = parseBaseline(readFileSync(path, "utf8"));
	return parsed.success ? ok({ side: parsed.data }) : err(`${path}: ${parsed.error}`);
}

export type GuardOutcome =
	| { kind: "ok"; lines: string[] }
	| { kind: "regressed"; lines: string[]; violations: string[] }
	| { kind: "missing"; message: string };

type MetricSpec = {
	name: string;
	read: (m: GuardMetrics) => number | undefined;
	show: (n: number) => string;
};

const METRICS: readonly MetricSpec[] = [
	{ name: "cpu-s/rep", read: (m) => m.cpuSecondsPerRep, show: (n) => n.toFixed(2) },
	{ name: "rss peak", read: (m) => m.rssPeakBytes, show: (n) => `${(n / 1e6).toFixed(1)} MB` },
];

const GUARDED: FrameworkKey = "warden";

/** Rounded to one decimal, so the printed percent and the threshold test agree. */
const pctChange = (a: number, b: number): number => Math.round(((b - a) / a) * 1000) / 10;
const signed = (pct: number): string => `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}`;

/**
 * The warden CPU guard: B regresses when its host CPU-seconds per rep or host RSS peak exceed A's by more than
 * `thresholdPct` percent. A framework or metric missing on either side is `missing` (a usage error), never a
 * pass, and so is a zero baseline, which has no percentage.
 */
export function checkRegression(a: GuardSide, b: GuardSide, thresholdPct: number): GuardOutcome {
	const ma = a.metrics[GUARDED];
	const mb = b.metrics[GUARDED];
	if (ma === undefined) return { kind: "missing", message: `${GUARDED} is not an ok framework in A (${a.id})` };
	if (mb === undefined) return { kind: "missing", message: `${GUARDED} is not an ok framework in B (${b.id})` };
	const lines: string[] = [];
	const violations: string[] = [];
	for (const spec of METRICS) {
		const va = spec.read(ma);
		const vb = spec.read(mb);
		if (va === undefined) return { kind: "missing", message: `${GUARDED} has no ${spec.name} in A (${a.id})` };
		if (vb === undefined) return { kind: "missing", message: `${GUARDED} has no ${spec.name} in B (${b.id})` };
		if (va <= 0) {
			return {
				kind: "missing",
				message: `${GUARDED} ${spec.name} in A (${a.id}) is ${va}, so a percent change is undefined`,
			};
		}
		const pct = pctChange(va, vb);
		const move = `${GUARDED} ${spec.name} ${spec.show(va)} → ${spec.show(vb)} (${signed(pct)} %)`;
		if (pct > thresholdPct) violations.push(`regression: ${move} exceeds ${thresholdPct} %`);
		else lines.push(`ok: ${move} within ${thresholdPct} %`);
	}
	return violations.length > 0 ? { kind: "regressed", lines, violations } : { kind: "ok", lines };
}
