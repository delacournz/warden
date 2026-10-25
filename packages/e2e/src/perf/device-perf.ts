import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2eError } from "../errors";
import { checkBudgets, describeBreaches, type PerfBudgets } from "./budgets";
import type { PerfReport, PerfStartOptions } from "./perf.types";

/** One `warden` invocation: argv (without the warden command itself) in, exit code and streams out. */
export type PerfExec = (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Subdirectory of the attempt dir a perf session's report is copied to. */
export const PERF_DIR = "perf";

export type DevicePerf = {
	/** opens a perf session on this device; one per device at a time */
	start(options?: PerfStartOptions): Promise<{ sessionId: string }>;
	/** drops a label on the session timeline; commits, hangs and jank are tagged with the last mark before them */
	mark(label: string): Promise<void>;
	/**
	 * Ends the session and returns its report (`reportPath` is the copy under the attempt's `perf/`). Throws
	 * `PERF_BUDGET` when a metric is over the suite's budget (`warden.config.ts` `perf.budgets`) or `budgets`, which
	 * replaces the suite's per key.
	 */
	stop(options?: { budgets?: PerfBudgets }): Promise<PerfReport>;
	/** a session this device opened and has not stopped */
	readonly active: boolean;
};

export type DevicePerfDeps = {
	exec: PerfExec;
	udid: string;
	/** budgets of the suite (`WARDEN_PERF_BUDGETS`) */
	budgets: PerfBudgets;
	/** the running attempt's dir; absent outside an attempt (the report stays in the session dir) */
	attemptDir: () => string | undefined;
	/** records a file written into the attempt dir (relative path) so `results.jsonl` lists it */
	addFile?: (relative: string) => void;
	/** `warden` is not reachable (no `WARDEN_BIN`) */
	unavailable?: string;
};

type Envelope = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; hint?: string } };

function parseEnvelope(stdout: string): Envelope | undefined {
	try {
		const json: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
		if (typeof json !== "object" || json === null || !("ok" in json)) return undefined;
		return json as Envelope;
	} catch {
		return undefined;
	}
}

const flagsOf = (o: PerfStartOptions): string[] => [
	...(o.js ? ["--js"] : []),
	...(o.react ? ["--react"] : []),
	...(typeof o.native === "string" ? [`--native=${o.native}`] : o.native ? ["--native"] : []),
	...(o.metrics ? ["--metrics"] : []),
	...(o.frames ? ["--frames"] : []),
	...(o.logs ? ["--logs"] : []),
	...(o.all ? ["--all"] : []),
	...(o.relaunch ? ["--relaunch"] : []),
	...(o.reset ? ["--reset"] : []),
	...(o.maxDurationMs === undefined ? [] : ["--max-duration", `${Math.ceil(o.maxDurationMs / 1000)}s`]),
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Copies the session's `report.json` / `report.md` and a `session.json` pointer into `<attempt>/perf/`, recording each
 * file; returns where `report.json` is (the session's own when no attempt is running).
 */
function saveReport(
	deps: DevicePerfDeps,
	result: Record<string, unknown>,
	report: Record<string, unknown>,
	sessionId: string
): string | undefined {
	const sessionReport = typeof result.reportPath === "string" ? result.reportPath : undefined;
	const attempt = deps.attemptDir();
	if (attempt === undefined) return sessionReport;
	const out = join(attempt, PERF_DIR);
	mkdirSync(out, { recursive: true });
	const sessionDir = typeof result.dir === "string" ? result.dir : undefined;
	const write = (name: string, from: string | undefined, fallback?: string): void => {
		if (from !== undefined && existsSync(from)) copyFileSync(from, join(out, name));
		else if (fallback !== undefined) writeFileSync(join(out, name), fallback);
		else return;
		deps.addFile?.(`${PERF_DIR}/${name}`);
	};
	write("report.json", sessionReport, `${JSON.stringify(report, null, 2)}\n`);
	write("report.md", sessionDir === undefined ? undefined : join(sessionDir, "report.md"));
	write("session.json", undefined, `${JSON.stringify({ sessionId, dir: sessionDir }, null, 2)}\n`);
	return join(out, "report.json");
}

export function createDevicePerf(deps: DevicePerfDeps): DevicePerf {
	const run = async (sub: string, extra: readonly string[]): Promise<Record<string, unknown>> => {
		if (deps.unavailable !== undefined) throw new E2eError("SESSION", `device.perf unavailable: ${deps.unavailable}`);
		const { code, stdout, stderr } = await deps.exec(["perf", sub, "--json", "--udid", deps.udid, ...extra]);
		const env = parseEnvelope(stdout);
		if (env === undefined || !env.ok) {
			const why = env === undefined ? stderr.trim() || `exit ${code}` : `${env.error.code}: ${env.error.message}`;
			throw new E2eError("SESSION", `warden perf ${sub} failed: ${why}`);
		}
		return isRecord(env.result) ? env.result : {};
	};

	let active = false;
	return {
		get active() {
			return active;
		},
		async start(options = {}) {
			const result = await run("start", flagsOf(options));
			const sessionId = result.sessionId;
			if (typeof sessionId !== "string") throw new E2eError("SESSION", "warden perf start returned no sessionId");
			active = true;
			return { sessionId };
		},
		async mark(label) {
			await run("mark", [label]);
		},
		async stop(options = {}) {
			const result = await run("stop", []);
			active = false;
			const report = result.report;
			if (!isRecord(report)) throw new E2eError("SESSION", "warden perf stop returned no report");
			const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
			const reportPath = saveReport(deps, result, report, sessionId);
			const typed = { ...report, ...(reportPath === undefined ? {} : { reportPath }) } as PerfReport;
			const breaches = checkBudgets(typed, deps.budgets, options.budgets);
			if (breaches.length > 0) throw new E2eError("PERF_BUDGET", describeBreaches(breaches, reportPath));
			return typed;
		},
	};
}

const CAPTURE_NAMES = ["js", "react", "native", "metrics", "frames", "logs"] as const;

/** `--perf=react,js` (or `all`) as the options `perf.start` takes; an unknown name is ignored, none named = warden's default set. */
export function perfStartFor(names: readonly string[]): PerfStartOptions {
	if (names.includes("all")) return { all: true };
	const out: PerfStartOptions = {};
	for (const name of CAPTURE_NAMES) if (names.includes(name)) out[name] = true;
	return out;
}

/** Runs the `warden` that started the spec process (`WARDEN_BIN`). */
export function spawnWarden(bin: readonly string[] | undefined): PerfExec {
	return async (argv) => {
		if (bin === undefined) return { code: 1, stdout: "", stderr: "WARDEN_BIN is not set" };
		const proc = Bun.spawn([...bin, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	};
}
