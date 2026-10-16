#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BenchAdapter, RunContext } from "./adapters/adapter.types";
import { ADAPTERS } from "./adapters/registry";
import { type Command, HELP, parseArgs } from "./args";
import { realExec } from "./harness/exec";
import { type BenchDeps, runBench, writeReports } from "./orchestrator";
import { compareRuns, renderCompareMarkdown } from "./report/compare";
import { renderHtml } from "./report/html";
import { loadManifest } from "./results/manifest";
import { CANONICAL_IDS, type Platform } from "./results/schema";
import { readBenchResults } from "./results/write";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "../..");
const CLI_PATH = join(REPO_ROOT, "apps/cli/src/cli.ts");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pads cells into aligned columns. */
function table(rows: readonly (readonly string[])[]): string {
	const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	return rows
		.map((r) =>
			r
				.map((c, i) => c.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd()
		)
		.join("\n");
}

function doctorContext(platform: Platform, adapter: BenchAdapter): RunContext {
	const outDir = join(REPO_ROOT, ".bench", "doctor", adapter.id);
	mkdirSync(outDir, { recursive: true });
	return {
		platform,
		udid: "",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "",
		outDir,
		cold: true,
		retries: 0,
		env: { ...process.env },
		exec: realExec,
		log: () => undefined,
		packageRoot: PACKAGE_ROOT,
		repoRoot: REPO_ROOT,
	};
}

/** Doctor table; exit 1 when a framework other than detox (best effort) is not ok. */
async function doctor(platform: Platform): Promise<number> {
	const rows: string[][] = [["framework", "status", "version", "notes / hint"]];
	let code = 0;
	for (const adapter of ADAPTERS) {
		if (!adapter.supports.includes(platform)) {
			rows.push([adapter.id, "n/a", "-", `does not support ${platform}`]);
			continue;
		}
		const d = await adapter.doctor(doctorContext(platform, adapter));
		if (d.ok) {
			rows.push([adapter.id, "ok", d.version, d.notes.join("; ")]);
			continue;
		}
		rows.push([adapter.id, "missing", "-", `${d.reason} -> ${d.installHint}`]);
		if (adapter.id !== "detox") code = 1;
	}
	console.log(table(rows));
	return code;
}

function list(): number {
	const manifest = loadManifest(PACKAGE_ROOT);
	console.log("frameworks:");
	for (const adapter of ADAPTERS) console.log(`  ${adapter.id}  (${adapter.supports.join(", ")})`);
	console.log("tests:");
	for (const id of CANONICAL_IDS) console.log(`  ${id}  ${manifest.tests[id]?.title ?? ""}`);
	return 0;
}

function report(runDir: string): number {
	const run = readBenchResults(runDir);
	if (!run.success) {
		console.error(run.error);
		return 1;
	}
	writeReports(runDir, run.data, { manifest: loadManifest(PACKAGE_ROOT), renderHtml });
	console.log(`wrote ${join(runDir, "report.md")} and report.html`);
	return 0;
}

function compare(dirA: string, dirB: string): number {
	const a = readBenchResults(dirA);
	const b = readBenchResults(dirB);
	if (!a.success || !b.success) {
		console.error(!a.success ? a.error : !b.success ? b.error : "");
		return 1;
	}
	console.log(renderCompareMarkdown(compareRuns(a.data, b.data), loadManifest(PACKAGE_ROOT)));
	return 0;
}

/** SIGINT / SIGTERM abort the run (teardown, release, write results); a second signal exits at once. */
function abortOnSignal(): AbortSignal {
	const controller = new AbortController();
	const handler = (): void => {
		if (controller.signal.aborted) process.exit(130);
		console.error("interrupted: finishing the current phase, tearing down and writing results (signal again to force)");
		controller.abort();
	};
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
	return controller.signal;
}

async function run(cmd: Extract<Command, { command: "run" }>): Promise<number> {
	const { command: _command, ...opts } = cmd;
	const deps: BenchDeps = {
		exec: realExec,
		now: () => new Date(),
		adapters: ADAPTERS,
		cliPath: CLI_PATH,
		repoRoot: REPO_ROOT,
		packageRoot: PACKAGE_ROOT,
		manifest: loadManifest(PACKAGE_ROOT),
		log: (line) => console.log(line),
		sleep,
		env: { ...process.env },
		signal: abortOnSignal(),
		renderHtml,
	};
	const outcome = await runBench(opts, deps);
	if (!outcome.success) {
		console.error(`bench: ${outcome.error}`);
		return 1;
	}
	if (outcome.data.interrupted) return 130;
	return outcome.data.run.frameworks.some((f) => f.status === "failed") ? 1 : 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const cmd = parseArgs(argv);
	if (typeof cmd === "string") {
		console.error(`bench: ${cmd}\n\n${HELP}`);
		return 2;
	}
	switch (cmd.command) {
		case "help":
			console.log(HELP);
			return 0;
		case "run":
			return run(cmd);
		case "doctor":
			return doctor(cmd.platform);
		case "list":
			return list();
		case "report":
			return report(cmd.runDir);
		case "compare":
			return compare(cmd.dirA, cmd.dirB);
	}
}

if (import.meta.main) process.exit(await main());
