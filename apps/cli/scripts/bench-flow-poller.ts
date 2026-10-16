#!/usr/bin/env bun
/**
 * CPU the batch's flow poller spends following a growing `results.jsonl`, before and after PERF-5.1.
 *   bun scripts/bench-flow-poller.ts [--lines 5000] [--ticks 100] [--rounds 3]
 *
 * The file grows by `lines / ticks` results between polls (one poll a second in a real run, so 100
 * ticks is a 100 s run) and each poll's CPU time (user + system) is summed. `legacy` is the poller
 * as it was: re-read the whole file, parse it twice (marks, then the new lines), resolve every
 * result's path again. `incremental` is `flowPoller`. Both read a real file.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readResults, type TestResult } from "@delacour/warden-e2e/runner/results";
import { flowPoller } from "../src/batch/flow-poller";
import { type FlowMark, failing, flowOf, realPath, type TrackedFlow, testLine } from "../src/batch/flow-progress";
import { readFileFrom } from "../src/batch/results-tail";

const { values } = parseArgs({
	options: {
		lines: { type: "string", default: "5000" },
		ticks: { type: "string", default: "100" },
		rounds: { type: "string", default: "3" },
	},
	strict: true,
});
const LINES = Number(values.lines);
const TICKS = Number(values.ticks);
const ROUNDS = Number(values.rounds);
const FLOW_COUNT = 8;

type Run = { cpuMs: number; polls: number; lines: number; fileBytes: number };

/** the spec files the results name: real files, so path resolution costs what it does in a run */
function makeFlows(dir: string): TrackedFlow[] {
	return Array.from({ length: FLOW_COUNT }, (_, i) => {
		const path = join(dir, `flow-${i}.e2e.ts`);
		writeFileSync(path, "");
		return { id: `flow-${i}`, path };
	});
}

/** result `n` of the run: tests run flow by flow, as bun runs them */
function resultLine(flows: readonly TrackedFlow[], n: number): string {
	const flow = flows[Math.floor((n / LINES) * FLOW_COUNT)] ?? flows[0];
	const result: TestResult = {
		file: flow?.path ?? "",
		title: ["sign in", `case ${n}`],
		status: n % 97 === 0 ? "failed" : "passed",
		durationMs: 1000 + (n % 700),
		startedAt: 1_700_000_000_000 + n * 1000,
		artifacts: { dir: `/out/${n}`, files: ["trace.jsonl", "screen.txt"] },
		device: { udid: "00000000-0000-0000-0000-000000000000", platform: "ios", name: "iPhone 16" },
	};
	return `${JSON.stringify(result)}\n`;
}

/** `resultsMarks` before PERF-5.1: parse the text, resolve every result's file against every flow */
function legacyMarks(jsonl: string, flows: readonly TrackedFlow[], final: boolean): Record<string, FlowMark> {
	const results = readResults(jsonl);
	const owners = results.map((r) => flowOf(r, flows, realPath)?.id);
	const marks: Record<string, FlowMark> = {};
	const last = new Map<string, number>();
	results.forEach((result, i) => {
		const id = owners[i];
		if (id === undefined) return;
		last.set(id, i);
		if (failing(result)) marks[id] = "failed";
	});
	for (const [id, at] of last) {
		if (marks[id]) continue;
		if (final || owners.slice(at + 1).some((o) => o !== undefined && o !== id)) marks[id] = "passed";
	}
	return marks;
}

const cpuMs = (since: NodeJS.CpuUsage) => {
	const used = process.cpuUsage(since);
	return (used.user + used.system) / 1000;
};

async function runLegacy(path: string, flows: readonly TrackedFlow[]): Promise<Run> {
	let printed = 0;
	let lines = 0;
	let polls = 0;
	let cpu = 0;
	for (let tick = 0; tick < TICKS; tick++) {
		appendTick(path, flows, tick);
		const since = process.cpuUsage();
		const text = await readFile(path, "utf8").catch(() => "");
		legacyMarks(text, flows, tick === TICKS - 1);
		const results = readResults(text);
		const fresh = results.slice(printed);
		printed = results.length;
		for (const result of fresh) {
			const flow = flowOf(result, flows);
			if (flow) lines += testLine(flow.id, result).length > 0 ? 1 : 0;
		}
		cpu += cpuMs(since);
		polls++;
	}
	return { cpuMs: cpu, polls, lines, fileBytes: Bun.file(path).size };
}

async function runIncremental(path: string, flows: readonly TrackedFlow[]): Promise<Run> {
	let lines = 0;
	let polls = 0;
	let cpu = 0;
	const ended = new Set<string>();
	const poller = flowPoller({ every: () => () => {}, readFrom: readFileFrom }, flows, new Map([["1:0", path]]), ended, {
		flows: () => {},
		tests: (l) => (lines += l.length),
	});
	for (let tick = 0; tick < TICKS; tick++) {
		appendTick(path, flows, tick);
		if (tick === TICKS - 1) ended.add("1:0");
		const since = process.cpuUsage();
		await poller.poll();
		cpu += cpuMs(since);
		polls++;
	}
	return { cpuMs: cpu, polls, lines, fileBytes: Bun.file(path).size };
}

function appendTick(path: string, flows: readonly TrackedFlow[], tick: number): void {
	const per = LINES / TICKS;
	let chunk = "";
	for (let i = 0; i < per; i++) chunk += resultLine(flows, tick * per + i);
	appendFileSync(path, chunk);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const root = mkdtempSync(join(tmpdir(), "bench-flow-poller-"));
try {
	const flows = makeFlows(root);
	const legacy: Run[] = [];
	const incremental: Run[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		for (const [name, run, into] of [
			["legacy", runLegacy, legacy],
			["incremental", runIncremental, incremental],
		] as const) {
			const dir = join(root, `${name}-${round}`);
			mkdirSync(dir);
			const path = join(dir, "results.jsonl");
			writeFileSync(path, "");
			into.push(await run(path, flows));
		}
	}
	const before = median(legacy.map((r) => r.cpuMs));
	const after = median(incremental.map((r) => r.cpuMs));
	const first = legacy[0];
	console.log(
		`${LINES} results over ${TICKS} polls (${((first?.fileBytes ?? 0) / 1024).toFixed(0)} KB), median of ${ROUNDS} rounds`
	);
	console.log(`legacy       ${before.toFixed(1).padStart(8)} ms CPU  (${(before / TICKS).toFixed(2)} ms/poll)`);
	console.log(`incremental  ${after.toFixed(1).padStart(8)} ms CPU  (${(after / TICKS).toFixed(2)} ms/poll)`);
	console.log(`${(before / Math.max(after, 0.001)).toFixed(0)}x less CPU`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
