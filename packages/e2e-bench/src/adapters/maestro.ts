import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ok, type Result } from "@delacour/warden-types/result";
import type { ExecResult } from "../harness/exec";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult, StepResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type RunContext,
	type TestResult,
} from "./adapter.types";
import { type JunitCase, parseJunit } from "./parse/junit";
import { parseMaestroCommands } from "./parse/maestro-commands";

/** Upper bound for one whole `maestro test` pass (8 flows, ~3-4 min warm; a hung driver ends here). */
export const MAESTRO_TIMEOUT_MS = 20 * 60_000;
export const MAESTRO_INSTALL_HINT = "brew install maestro";
export const JAVA_INSTALL_HINT = "brew install openjdk@21";

/** Everything impure besides spawning; tests replace it. */
export type MaestroDeps = {
	readText: (path: string) => string | undefined;
	writeText: (path: string, text: string) => void;
	/** names of the entries in `dir` (empty when it does not exist) */
	listDir: (dir: string) => string[];
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

export const defaultMaestroDeps: MaestroDeps = {
	readText: readTextIfPresent,
	writeText: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	},
	listDir: (dir) => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
};

const suiteDir = (ctx: Pick<RunContext, "packageRoot">): string => join(ctx.packageRoot, "suites/maestro");
const bad = (error: AdapterError): { success: false; error: AdapterError } => ({ success: false, error });

/**
 * `maestro` argv. `--udid` is the iOS simulator UDID or the Android serial (same flag). Flows address
 * elements with `id:`, which Maestro maps to the iOS accessibilityIdentifier (the RN testID) and to the Android
 * resource-id (RN testID is exposed as resource-id with `testID` -> view tag). Warm reps pass
 * `--no-reinstall-driver`, so the driver install lands in rep 1 only (the cold-start cost the report charges).
 * Maestro has no retry flag: `retries` is not forwarded (the suite's own `retry:` blocks are the parity retries).
 */
export function maestroArgv(o: {
	udid: string;
	suiteDir: string;
	junitPath: string;
	testOutputDir: string;
	cold: boolean;
}): string[] {
	return [
		"--udid",
		o.udid,
		"test",
		o.suiteDir,
		"--format",
		"junit",
		"--output",
		o.junitPath,
		"--test-output-dir",
		o.testOutputDir,
		"--no-ansi",
		...(o.cold ? [] : ["--no-reinstall-driver"]),
	];
}

/** Analytics and update checks off, so they add no network wait to a measured pass. */
export function maestroEnv(env: RunContext["env"]): Record<string, string | undefined> {
	return { ...env, MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_DISABLE_UPDATE_CHECK: "true" };
}

/** First line of `maestro --version` that looks like a version (skips update banners). */
function versionLine(stdout: string): string {
	return (
		stdout
			.split("\n")
			.find((l) => /^\d+\.\d+/.test(l.trim()))
			?.trim() ??
		stdout.trim().split("\n")[0] ??
		""
	);
}

/** `openjdk version "21.0.10" ...` (stderr) → `21.0.10`. */
function javaVersion(text: string): string | undefined {
	return /version "([^"]+)"/.exec(text)?.[1];
}

async function doctor(ctx: RunContext): Promise<Doctor> {
	const version = await ctx.exec.run("maestro", ["--version"], { env: maestroEnv(ctx.env) });
	if (version.code !== 0)
		return { ok: false, reason: "maestro is not installed or not runnable", installHint: MAESTRO_INSTALL_HINT };
	const java = await ctx.exec.run("java", ["-version"]);
	const javaV = java.code === 0 ? javaVersion(`${java.stderr}\n${java.stdout}`) : undefined;
	if (javaV === undefined)
		return { ok: false, reason: "java is not installed (Maestro needs JDK 17+)", installHint: JAVA_INSTALL_HINT };
	return { ok: true, version: `maestro ${versionLine(version.stdout)}`, notes: [`java ${javaV}`] };
}

/** Nothing to warm: on a cold rep the first `maestro test` installs the driver, and that cost is rep 1's by design. */
async function prepare(): Promise<Result<void>> {
	return ok(undefined);
}

/** Maestro / driver leftovers: matched on the `ps` command column. */
export const MAESTRO_PROCESS_RE = /java.*maestro|maestro-driver|maestro\.cli/i;

/** Parses `ps -axo pid=,command=` lines and returns the pids whose command matches a Maestro process. */
export function maestroPids(psOutput: string, selfPid: number): number[] {
	const pids: number[] = [];
	for (const line of psOutput.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m?.[1] === undefined || m[2] === undefined) continue;
		const pid = Number(m[1]);
		if (pid !== selfPid && MAESTRO_PROCESS_RE.test(m[2]) && !m[2].includes("bun test")) pids.push(pid);
	}
	return pids;
}

async function teardown(ctx: RunContext): Promise<Result<void>> {
	const ps = await ctx.exec.run("ps", ["-axo", "pid=,command="]);
	for (const pid of maestroPids(ps.stdout, process.pid)) await ctx.exec.run("kill", [String(pid)]);
	return ok(undefined);
}

/**
 * `commands.json` of one flow. Maestro writes `<test-output-dir>/<timestamp>/<flow name>/commands.json`
 * (older versions drop the timestamp level); the newest timestamp wins.
 */
export function findCommandsJson(deps: MaestroDeps, root: string, flowName: string): string | undefined {
	const candidates = [
		...deps
			.listDir(root)
			.sort()
			.reverse()
			.map((ts) => join(root, ts, flowName, "commands.json")),
	];
	candidates.push(join(root, flowName, "commands.json"));
	return candidates.find((p) => deps.readText(p) !== undefined);
}

function stepsFor(deps: MaestroDeps, ctx: RunContext, flowName: string): { steps?: StepResult[]; path?: string } {
	const root = join(ctx.outDir, "maestro-out");
	const found = findCommandsJson(deps, root, flowName);
	const text = found === undefined ? undefined : deps.readText(found);
	if (found === undefined || text === undefined) return {};
	const parsed = parseMaestroCommands(text);
	const rel = found.slice(ctx.outDir.length + 1);
	return parsed.success ? { steps: parsed.data, path: rel } : { path: rel };
}

function testOf(deps: MaestroDeps, ctx: RunContext, id: TestResult["id"], c: JunitCase): TestResult {
	const { steps, path } = stepsFor(deps, ctx, c.name);
	return {
		id,
		nativeName: c.name,
		status: c.status,
		durationMs: c.durationMs,
		...(steps !== undefined ? { steps } : {}),
		...(c.error !== undefined ? { error: c.error } : {}),
		artifacts: [{ kind: "junit", path: "junit.xml" }, ...(path !== undefined ? [{ kind: "json" as const, path }] : [])],
	};
}

/** Canonical rep from the junit cases; an unmapped native name is a parity breach. */
function toRep(
	deps: MaestroDeps,
	ctx: RunContext,
	cases: JunitCase[],
	wallMs: number,
	startedAt: string
): Result<RepResult, AdapterError> {
	const byId = new Map<TestResult["id"], TestResult>();
	const native = cases.map((c) => ({ nativeName: c.name, junit: c }));
	const joined = joinNative(loadManifest(ctx.packageRoot), "maestro", native, (id, n) => {
		byId.set(id, testOf(deps, ctx, id, n.junit));
		return { id, nativeName: n.nativeName, status: n.junit.status };
	});
	if (joined.unmapped.length > 0) return bad(failed(`parity breach: unmapped tests: ${joined.unmapped.join(", ")}`));
	const tests: TestResult[] = joined.mapped.map(
		(m) => byId.get(m.id) ?? { id: m.id, nativeName: m.nativeName, status: "missing" }
	);
	return ok({
		index: 1,
		cold: ctx.cold,
		wallMs,
		wallSource: "harness",
		startedAt,
		tests,
		rawArtifactDir: ctx.outDir,
	});
}

function noJunit(ran: ExecResult, detail: string): Result<RepResult, AdapterError> {
	const tail = `${ran.stderr}\n${ran.stdout}`.trim().split("\n").slice(-5).join("\n");
	return bad(failed(`maestro test wrote no usable junit (exit ${ran.code}): ${detail}${tail ? `\n${tail}` : ""}`));
}

async function run(ctx: RunContext, deps: MaestroDeps): Promise<Result<RepResult, AdapterError>> {
	const junitPath = join(ctx.outDir, "junit.xml");
	const argv = maestroArgv({
		udid: ctx.udid,
		suiteDir: suiteDir(ctx),
		junitPath,
		testOutputDir: join(ctx.outDir, "maestro-out"),
		cold: ctx.cold,
	});
	if (ctx.retries > 0) ctx.log(`maestro has no retry flag; --retries ${ctx.retries} is not forwarded`);
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const ran = await ctx.exec.run("maestro", argv, {
		cwd: ctx.packageRoot,
		env: maestroEnv(ctx.env),
		timeoutMs: MAESTRO_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	const wallMs = performance.now() - t0;
	deps.writeText(join(ctx.outDir, "maestro.log"), `${ran.stdout}\n${ran.stderr}`);
	if (ran.spawnError !== undefined) return bad(failed(`maestro: ${ran.spawnError}`));
	if (ran.timedOut) return bad(failed(`maestro test exceeded the ${MAESTRO_TIMEOUT_MS / 60_000} min timeout`));
	const xml = deps.readText(junitPath);
	if (xml === undefined) return noJunit(ran, "junit file missing");
	const parsed = parseJunit(xml);
	if (!parsed.success) return noJunit(ran, parsed.error);
	return toRep(deps, ctx, parsed.data, wallMs, startedAt);
}

/** The adapter over injectable deps; `maestroAdapter` is the real one. */
export function createMaestroAdapter(deps: MaestroDeps): BenchAdapter {
	return {
		id: "maestro",
		supports: ["ios", "android"],
		doctor,
		prepare,
		run: (ctx) => run(ctx, deps),
		teardown,
		residuePatterns: {
			processes: [/java.*maestro/i, /maestro-driver/i],
			driverBundleIds: [
				"dev.mobile.maestro-driver-iosUITests.xctrunner",
				"dev.mobile.maestro-driver-ios",
				"dev.mobile.maestro",
				"dev.mobile.maestro.test",
			],
			dirs: ["~/.maestro"],
		},
	};
}

export const maestroAdapter: BenchAdapter = createMaestroAdapter(defaultMaestroDeps);
