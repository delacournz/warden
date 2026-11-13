#!/usr/bin/env bun
import { resolve } from "node:path";
import { realExec } from "@delacour/warden-e2e-bench/src/harness/exec";
import { type Args, HELP, parseArgs } from "./args";
import { allPassed, REPORT_FILE, REPORT_MD, renderMarkdown } from "./report";
import { type RunInput, runAgentBench } from "./run";
import { type LoadedSuite, listSuites, loadSuite, resolveSuitePath } from "./suite";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The run's input from the parsed flags (only the ones given). */
function runInput(args: Extract<Args, { kind: "run" }>, loaded: LoadedSuite): RunInput {
	return {
		loaded,
		repoRoot: REPO_ROOT,
		...(args.udid !== undefined ? { udid: args.udid } : {}),
		...(args.model !== undefined ? { model: args.model } : {}),
		...(args.out !== undefined ? { outDir: resolve(args.out) } : {}),
		...(args.tools !== undefined ? { tools: args.tools } : {}),
	};
}

/** `bun run bench:agent`: exit 0 every tool passed, 1 any tool did not (or was unavailable), 2 usage or setup error. */
async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.success) {
		console.error(`bench:agent: ${String(parsed.error)}\n\n${HELP}`);
		return 2;
	}
	const args = parsed.data;
	if (args.kind === "help") {
		console.log(HELP);
		return 0;
	}
	if (args.kind === "list") {
		for (const name of listSuites()) {
			const loaded = loadSuite(resolveSuitePath(name));
			console.log(loaded.success ? `${name}\t${loaded.data.suite.description}` : `${name}\t(invalid: ${loaded.error})`);
		}
		return 0;
	}
	const loaded = loadSuite(resolveSuitePath(args.suite));
	if (!loaded.success) {
		console.error(`bench:agent: ${String(loaded.error)}`);
		return 2;
	}
	const controller = new AbortController();
	const onSignal = (): void => {
		if (controller.signal.aborted) process.exit(130);
		console.error("bench:agent: stopping the agent (Ctrl-C again to quit without releasing)");
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const out = await runAgentBench(runInput(args, loaded.data), {
		exec: realExec,
		env: process.env,
		now: () => new Date(),
		log: (line) => console.error(`bench:agent: ${line}`),
		bunPath: process.execPath,
		signal: controller.signal,
	});
	if (!out.success) {
		console.error(`bench:agent: ${String(out.error)}`);
		return 2;
	}
	const { report, runDir } = out.data;
	console.log(args.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
	console.error(`bench:agent: ${runDir}/${REPORT_FILE} · ${runDir}/${REPORT_MD}`);
	return allPassed(report) ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
