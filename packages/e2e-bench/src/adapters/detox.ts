import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { ExecResult } from "../harness/exec";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type RunContext,
	type TestResult,
	unsupported,
} from "./adapter.types";
import { type JestTest, parseJestJson } from "./parse/jest-json";

/**
 * Detox 20.51 supports RN up to 0.84 and the example app is on 0.86, so the harness treats a doctor
 * `ok: false` for this framework as `unsupported` (not `failed`): the missing `applesimutils` hint is a
 * reportable outcome of the benchmark, not a harness error.
 */
export const DETOX_BEST_EFFORT = true;

/** Upper bound for the whole `detox test` process; a hung synchronization wait ends here as `unsupported`. */
export const DETOX_JOB_TIMEOUT_MS = 15 * 60_000;
export const APPLESIMUTILS_HINT = "brew tap wix/brew && brew install applesimutils";
export const DETOX_ANDROID_REASON =
	"detox android needs an instrumented build; set BENCH_DETOX_ANDROID=1 after applying @config-plugins/detox (WDN-BENCH-A6b)";

/** Error text that means "Detox cannot drive this app / environment" rather than "the test is wrong". */
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
	{ re: /applesimutils/i, reason: "applesimutils is missing or failed" },
	{ re: /The app has not responded/i, reason: "the app never responded to Detox (unsupported React Native version)" },
	{ re: /Detox can't seem to connect/i, reason: "Detox cannot attach to the app (unsupported React Native version)" },
	{
		re: /unexpectedly disconnected from Detox server/i,
		reason: "the app drops its Detox connection (unsupported React Native version)",
	},
	{ re: /Failed to run application/i, reason: "Detox failed to launch the app" },
	{ re: /synchroni[sz]ation/i, reason: "Detox synchronization never settled (unsupported React Native version)" },
	{ re: /timeout (of|exceeded)|Exceeded timeout|timed out/i, reason: "Detox timed out attaching to the app" },
];

/** First unsupported-pattern match in `text`, as a one-line reason that quotes the matched line. */
export function classifyDetoxFailure(text: string): string | undefined {
	for (const { re, reason } of UNSUPPORTED_PATTERNS) {
		const line = text.split("\n").find((l) => re.test(l));
		if (line !== undefined) return `${reason}: ${line.trim().slice(0, 240)}`;
	}
	return undefined;
}

/** `detox test` argv: jest's own `--json --outputFile` pass through after detox's flags (unknown flags are forwarded). */
export function detoxArgv(o: { retries: number; jsonPath: string }): string[] {
	return [
		"test",
		"-c",
		"ios.sim.release",
		...(o.retries > 0 ? ["--retries", String(o.retries)] : []),
		"--json",
		"--outputFile",
		o.jsonPath,
	];
}

/** The env contract `.detoxrc.js` reads. */
export function detoxEnv(
	ctx: Pick<RunContext, "appPath" | "udid" | "outDir" | "env">
): Record<string, string | undefined> {
	return {
		...ctx.env,
		BENCH_APP_PATH: ctx.appPath,
		BENCH_UDID: ctx.udid,
		BENCH_OUT: join(ctx.outDir, "detox-artifacts"),
	};
}

/** Everything impure besides spawning; tests replace it. */
export type DetoxDeps = {
	exists: (path: string) => boolean;
	readText: (path: string) => string | undefined;
	writeText: (path: string, text: string) => void;
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

export const defaultDetoxDeps: DetoxDeps = {
	exists: existsSync,
	readText: readTextIfPresent,
	writeText: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	},
};

const detoxBin = (ctx: RunContext): string => join(ctx.repoRoot, "node_modules/.bin/detox");
const suiteDir = (ctx: RunContext): string => join(ctx.packageRoot, "suites/detox");
const bad = (error: AdapterError): { success: false; error: AdapterError } => ({ success: false, error });

async function doctor(ctx: RunContext): Promise<Doctor> {
	const version = await ctx.exec.run(detoxBin(ctx), ["--version"], { cwd: suiteDir(ctx) });
	if (version.code !== 0) return { ok: false, reason: "detox CLI is not runnable", installHint: "bun install" };
	if (ctx.platform === "ios" && ctx.exec.which("applesimutils") === undefined)
		return {
			ok: false,
			reason: "applesimutils is not installed (Detox needs it for iOS simulators)",
			installHint: APPLESIMUTILS_HINT,
		};
	return {
		ok: true,
		version: `detox ${version.stdout.trim()}`,
		notes: ["supports RN <= 0.84; app is 0.86 (best effort)"],
	};
}

/** Builds Detox.framework into ~/Library/Detox up front so its one-off xcodebuild cost is not charged to rep 1. */
async function prepare(ctx: RunContext): Promise<Result<void>> {
	if (ctx.platform !== "ios") return ok(undefined);
	const ran = await ctx.exec.run(detoxBin(ctx), ["build-framework-cache"], {
		cwd: suiteDir(ctx),
		env: ctx.env,
		onLine: (_s, line) => ctx.log(line),
	});
	return ran.code === 0
		? ok(undefined)
		: err(`detox build-framework-cache exited ${ran.code}: ${ran.stderr.trim().slice(-300)}`);
}

/** Detox / jest / xcodebuild leftovers: matched on the `ps` command column. */
export const DETOX_PROCESS_RE = /DetoxServer|detox test|\/detox\/(local-cli|runners)|xcodebuild.*Detox/i;

/** Parses `ps -axo pid=,command=` lines and returns the pids whose command matches the detox patterns. */
export function detoxPids(psOutput: string, selfPid: number): number[] {
	const pids: number[] = [];
	for (const line of psOutput.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m?.[1] === undefined || m[2] === undefined) continue;
		const pid = Number(m[1]);
		if (pid !== selfPid && DETOX_PROCESS_RE.test(m[2]) && !m[2].includes("bun test")) pids.push(pid);
	}
	return pids;
}

async function teardown(ctx: RunContext): Promise<Result<void>> {
	const ps = await ctx.exec.run("ps", ["-axo", "pid=,command="]);
	for (const pid of detoxPids(ps.stdout, process.pid)) await ctx.exec.run("kill", [String(pid)]);
	return ok(undefined);
}

/** `unsupported` when jest's own output or the process text matches an attach/sync failure. */
function classifyOutput(ran: ExecResult, jsonError?: string): AdapterError {
	const text = [jsonError ?? "", ran.stderr, ran.stdout].join("\n");
	const reason = classifyDetoxFailure(text);
	if (reason !== undefined) return unsupported(reason);
	const tail = text.trim().split("\n").slice(-5).join("\n");
	return failed(`detox test wrote no usable jest json (exit ${ran.code})${tail ? `: ${tail}` : ""}`);
}

/** Canonical rep from the jest tests; an unmapped native name is a parity breach, an attach failure is unsupported. */
function toRep(
	ctx: RunContext,
	native: JestTest[],
	wallMs: number,
	startedAt: string
): Result<RepResult, AdapterError> {
	const byName = new Map(native.map((t) => [t.nativeName, t]));
	const joined = joinNative(loadManifest(ctx.packageRoot), "detox", native, (id, t) => ({
		id,
		nativeName: t.nativeName,
		status: t.status,
	}));
	if (joined.unmapped.length > 0) return bad(failed(`parity breach: unmapped tests: ${joined.unmapped.join(", ")}`));
	for (const t of native) {
		const reason = t.status === "failed" && t.error !== undefined ? classifyDetoxFailure(t.error) : undefined;
		if (reason !== undefined) return bad(unsupported(reason));
	}
	const tests: TestResult[] = joined.mapped.map((m) => {
		const t = byName.get(m.nativeName);
		if (t === undefined) return { id: m.id, nativeName: m.nativeName, status: "missing" };
		return {
			id: m.id,
			nativeName: t.nativeName,
			status: t.status,
			durationMs: t.durationMs,
			...(t.error !== undefined ? { error: t.error.split("\n").slice(0, 6).join("\n") } : {}),
		};
	});
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

async function run(ctx: RunContext, deps: DetoxDeps): Promise<Result<RepResult, AdapterError>> {
	if (ctx.platform === "android" && ctx.env.BENCH_DETOX_ANDROID !== "1") return bad(unsupported(DETOX_ANDROID_REASON));
	if (ctx.platform === "android") return bad(failed("detox android configuration is not implemented (WDN-BENCH-A6b)"));
	const jsonPath = join(ctx.outDir, "jest.json");
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const ran = await ctx.exec.run(detoxBin(ctx), detoxArgv({ retries: ctx.retries, jsonPath }), {
		cwd: suiteDir(ctx),
		env: detoxEnv(ctx),
		timeoutMs: DETOX_JOB_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	const wallMs = performance.now() - t0;
	deps.writeText(join(ctx.outDir, "detox.log"), `${ran.stdout}\n${ran.stderr}`);
	if (ran.spawnError !== undefined) return bad(failed(`detox test: ${ran.spawnError}`));
	if (ran.timedOut)
		return bad(
			unsupported(`detox test exceeded the ${DETOX_JOB_TIMEOUT_MS / 60_000} min job timeout (app never synchronized)`)
		);
	const text = deps.readText(jsonPath);
	if (text === undefined) return bad(classifyOutput(ran));
	const parsed = parseJestJson(text);
	if (!parsed.success) return bad(classifyOutput(ran, parsed.error));
	return toRep(ctx, parsed.data, wallMs, startedAt);
}

/** The adapter over injectable deps; `detoxAdapter` is the real one. */
export function createDetoxAdapter(deps: DetoxDeps): BenchAdapter {
	return {
		id: "detox",
		supports: ["ios", "android"],
		doctor,
		prepare,
		run: (ctx) => run(ctx, deps),
		teardown,
		residuePatterns: { processes: [/detox/i], driverBundleIds: [], dirs: ["~/Library/Detox"] },
	};
}

export const detoxAdapter: BenchAdapter = createDetoxAdapter(defaultDetoxDeps);
