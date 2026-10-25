import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { runOk } from "../harness/exec";
import { joinNative, loadManifest } from "../results/manifest";
import type { RepResult } from "../results/schema";
import {
	type AdapterError,
	type BenchAdapter,
	type Doctor,
	failed,
	type RunContext,
	type TestResult,
} from "./adapter.types";
import { parseWardenResults } from "./parse/warden-results";

/** The suite's spec files, in the order the run executes them (same order as the manifest). */
export const WARDEN_SPEC_FILES = [
	"onboarding.e2e.ts",
	"sign-in.e2e.ts",
	"todos.e2e.ts",
	"todo-detail.e2e.ts",
	"settings.e2e.ts",
] as const;

/** The spec's per-test timeout; `bun test` gets this plus a margin so the spec's own deadline error wins. */
export const SPEC_TIMEOUT_MS = 120_000;
const BUN_TIMEOUT_MARGIN_MS = 30_000;
/** Upper bound for the whole `bun test` process. */
const SUITE_TIMEOUT_MS = 15 * 60_000;
/** A unix socket path must fit in 104 bytes; warden falls back to /tmp past this. */
const MAX_SOCKET_PATH = 100;

/** Everything impure the adapter touches besides spawning; tests replace it. */
export type WardenDeps = {
	exists: (path: string) => boolean;
	readText: (path: string) => string | undefined;
	writeText: (path: string, text: string) => void;
	/** absolute path of `@delacour/warden-e2e/preload`; throws when it does not resolve */
	resolvePreload: () => string;
	home: () => string;
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

export const defaultWardenDeps: WardenDeps = {
	exists: existsSync,
	readText: readTextIfPresent,
	writeText: (path, text) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	},
	resolvePreload: () => import.meta.resolveSync("@delacour/warden-e2e/preload"),
	home: homedir,
};

/** `bun test --preload … --timeout … <files>` (what `warden e2e` runs per spec process, minus the JUnit file). */
export function wardenArgv(o: {
	preload: string;
	specPaths: readonly string[];
	timeoutMs: number;
	retries: number;
}): string[] {
	return [
		"test",
		"--preload",
		o.preload,
		"--timeout",
		String(o.timeoutMs + BUN_TIMEOUT_MARGIN_MS),
		...(o.retries > 0 ? ["--retry", String(o.retries)] : []),
		...o.specPaths,
	];
}

/** The `WARDEN_*` env contract of one spec process (`specEnv` in apps/cli plus the per-device keys). */
export function wardenSpecEnv(o: {
	udid: string;
	platform: string;
	bundleId: string;
	out: string;
	specsDir: string;
	helperDir: string;
	version: string;
	socketPath?: string;
}): Record<string, string> {
	return {
		WARDEN_UDID: o.udid,
		WARDEN_PLATFORM: o.platform,
		WARDEN_BUNDLE_ID: o.bundleId,
		WARDEN_LAUNCH_ARGS: "[]",
		WARDEN_E2E_OUT: o.out,
		WARDEN_E2E_TIMEOUT: String(SPEC_TIMEOUT_MS),
		WARDEN_E2E_SPECS_DIR: o.specsDir,
		WARDEN_HELPER_DIR: o.helperDir,
		WARDEN_VERSION: o.version,
		...(o.socketPath !== undefined ? { WARDEN_SIMD_SOCKET: o.socketPath } : {}),
	};
}

/** `$WARDEN_HOME/simd/<udid>.sock`, the path `warden ui` / `warden e2e` give the resident helper. */
export function simdSocketPath(env: RunContext["env"], home: string, udid: string): string {
	const wardenHome = env.WARDEN_HOME ?? join(home, ".warden");
	return join(wardenHome, "simd", `${udid}.sock`);
}

const bunOf = (ctx: RunContext): string => ctx.env.WARDEN_BUN ?? ctx.exec.which("bun") ?? process.execPath;
const cliOf = (ctx: RunContext): string => join(ctx.repoRoot, "apps/cli/src/cli.ts");
const helperDirOf = (ctx: RunContext): string =>
	ctx.env.WARDEN_HELPER_DIR ?? join(ctx.repoRoot, "packages/e2e/native/dist");
const suiteDirOf = (ctx: RunContext): string => join(ctx.packageRoot, "suites/warden");

/** warden's own version: the preload refuses to run when `@delacour/warden-e2e` differs. */
function cliVersion(ctx: RunContext, deps: WardenDeps): string | undefined {
	const text = deps.readText(join(ctx.repoRoot, "apps/cli/package.json"));
	if (text === undefined) return undefined;
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string")
			return raw.version;
	} catch {
		return undefined;
	}
	return undefined;
}

async function doctor(ctx: RunContext, deps: WardenDeps): Promise<Doctor> {
	const bun = await ctx.exec.run(bunOf(ctx), ["--version"]);
	if (bun.code !== 0) return { ok: false, reason: "bun is not runnable", installHint: "https://bun.sh" };
	try {
		deps.resolvePreload();
	} catch {
		return { ok: false, reason: "@delacour/warden-e2e/preload does not resolve", installHint: "bun install" };
	}
	const notes: string[] = [];
	if (ctx.platform === "ios") {
		const helper = join(helperDirOf(ctx), "warden-simd");
		if (!deps.exists(helper))
			return {
				ok: false,
				reason: `warden-simd helper missing at ${helper}`,
				installHint: "bun run --cwd packages/e2e native:build",
			};
		notes.push(`warden-simd: ${helper}`);
	}
	if (cliVersion(ctx, deps) === undefined)
		return { ok: false, reason: "apps/cli/package.json has no version", installHint: "check the checkout" };
	return { ok: true, version: `bun ${bun.stdout.trim()} + warden-e2e`, notes };
}

/** Starts the resident helper the way `warden e2e` does (a snapshot makes the in-sim bridge resident). */
async function prepare(ctx: RunContext): Promise<Result<void>> {
	if (ctx.platform !== "ios") return ok(undefined);
	const ran = await runOk(ctx.exec, bunOf(ctx), [cliOf(ctx), "ui", "snapshot", "--udid", ctx.udid, "--json"], {
		env: { ...ctx.env, WARDEN_HELPER_DIR: helperDirOf(ctx) },
		onLine: (_s, line) => ctx.log(line),
	});
	return ran.success ? ok(undefined) : err(ran.error);
}

async function teardown(ctx: RunContext): Promise<Result<void>> {
	if (ctx.platform !== "ios") return ok(undefined);
	const ran = await runOk(ctx.exec, bunOf(ctx), [cliOf(ctx), "ui", "close", "--udid", ctx.udid, "--json"], {
		env: ctx.env,
		onLine: (_s, line) => ctx.log(line),
	});
	return ran.success ? ok(undefined) : err(ran.error);
}

/** `err` is string-only; `run` fails with an `AdapterError`. */
const bad = (error: AdapterError): { success: false; error: AdapterError } => ({ success: false, error });

/** Maps native tests onto canonical ids; an unmapped name is a parity breach. */
function toRep(
	ctx: RunContext,
	native: ReturnType<typeof parseWardenResults>,
	wallMs: number,
	startedAt: string
): Result<RepResult, AdapterError> {
	const byName = new Map(native.map((t) => [t.nativeName, t]));
	const joined = joinNative(loadManifest(ctx.packageRoot), "warden", native, (id, t) => ({
		id,
		nativeName: t.nativeName,
		status: t.status,
	}));
	if (joined.unmapped.length > 0) return bad(failed(`parity breach: unmapped tests: ${joined.unmapped.join(", ")}`));
	const tests: TestResult[] = joined.mapped.map((m) => {
		const t = byName.get(m.nativeName);
		if (t === undefined) return { id: m.id, nativeName: m.nativeName, status: "missing" };
		return {
			id: m.id,
			nativeName: t.nativeName,
			status: t.status,
			durationMs: t.durationMs,
			steps: t.steps,
			...(t.untracedMs !== undefined ? { untracedMs: t.untracedMs } : {}),
			...(t.error !== undefined ? { error: t.error } : {}),
			...(t.artifacts.length > 0 ? { artifacts: t.artifacts } : {}),
		};
	});
	return ok({ index: 1, cold: ctx.cold, wallMs, wallSource: "harness", startedAt, tests, rawArtifactDir: ctx.outDir });
}

async function run(ctx: RunContext, deps: WardenDeps): Promise<Result<RepResult, AdapterError>> {
	const version = cliVersion(ctx, deps);
	if (version === undefined) return bad(failed("apps/cli/package.json has no version"));
	let preload: string;
	try {
		preload = deps.resolvePreload();
	} catch {
		return bad(failed("@delacour/warden-e2e/preload does not resolve (bun install)"));
	}
	const out = join(ctx.outDir, "warden-out");
	const socket = simdSocketPath(ctx.env, deps.home(), ctx.udid);
	const suiteDir = suiteDirOf(ctx);
	const env = {
		...ctx.env,
		...wardenSpecEnv({
			udid: ctx.udid,
			platform: ctx.platform,
			bundleId: ctx.bundleId,
			out,
			specsDir: suiteDir,
			helperDir: helperDirOf(ctx),
			version,
			...(ctx.platform === "ios" && socket.length < MAX_SOCKET_PATH && deps.exists(socket)
				? { socketPath: socket }
				: {}),
		}),
	};
	const argv = wardenArgv({
		preload,
		specPaths: WARDEN_SPEC_FILES.map((f) => join(suiteDir, f)),
		timeoutMs: SPEC_TIMEOUT_MS,
		retries: ctx.retries,
	});
	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const ran = await ctx.exec.run(bunOf(ctx), argv, {
		cwd: ctx.packageRoot,
		env,
		timeoutMs: SUITE_TIMEOUT_MS,
		onLine: (_s, line) => ctx.log(line),
	});
	const wallMs = performance.now() - t0;
	deps.writeText(join(ctx.outDir, "bun-test.log"), `${ran.stdout}\n${ran.stderr}`);
	if (ran.spawnError !== undefined) return bad(failed(`bun test: ${ran.spawnError}`));
	if (ran.timedOut) return bad(failed(`bun test timed out after ${SUITE_TIMEOUT_MS}ms`));
	const text = deps.readText(join(out, "results.jsonl"));
	if (text === undefined) {
		const tail = (ran.stderr || ran.stdout).trim().split("\n").slice(-5).join("\n");
		return bad(failed(`warden suite wrote no results.jsonl (exit ${ran.code})${tail ? `: ${tail}` : ""}`));
	}
	return toRep(ctx, parseWardenResults(text, deps.readText, ctx.outDir), wallMs, startedAt);
}

/** The adapter over injectable deps; `wardenAdapter` is the real one. */
export function createWardenAdapter(deps: WardenDeps): BenchAdapter {
	return {
		id: "warden",
		supports: ["ios", "android"],
		doctor: (ctx) => doctor(ctx, deps),
		prepare,
		run: (ctx) => run(ctx, deps),
		teardown,
		residuePatterns: { processes: [/warden-simd/], driverBundleIds: [], dirs: ["~/.warden/simd"] },
	};
}

export const wardenAdapter: BenchAdapter = createWardenAdapter(defaultWardenDeps);
