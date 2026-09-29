import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import { z } from "zod";
import { type Exec, execError } from "../exec";
import type { Platform } from "../types";
import { EAS_POLL_MS, EAS_TIMEOUT_MS, EAS_TRIGGER_GRACE_MS } from "./builds.defaults";
import type { EasSettings } from "./config";

const MINUTE = 60_000;

export const easBuildStatusSchema = z.enum([
	"NEW",
	"IN_QUEUE",
	"IN_PROGRESS",
	"PENDING_CANCEL",
	"ERRORED",
	"FINISHED",
	"CANCELED",
]);

/** The slice of eas-cli's `BuildFragment` (`eas build:list --json`) warden reads. */
export const easBuildSchema = z.object({
	id: z.string(),
	status: easBuildStatusSchema,
	createdAt: z.string(),
	platform: z.string().nullish(),
	isForIosSimulator: z.boolean().nullish(),
	artifacts: z.object({ applicationArchiveUrl: z.string().nullish() }).nullish(),
});

export type EasBuild = z.infer<typeof easBuildSchema>;

function parseJson<T>(stdout: string, schema: z.ZodType<T>, what: string): Result<T> {
	try {
		const parsed = schema.safeParse(JSON.parse(stdout));
		if (parsed.success) return ok(parsed.data);
		return err(`unexpected ${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
	} catch {
		return err(`unexpected ${what}: not JSON: ${stdout.trim().slice(0, 200)}`);
	}
}

export function parseBuildList(stdout: string): Result<EasBuild[]> {
	return parseJson(stdout, z.array(easBuildSchema), "`eas build:list` output");
}

/** `eas build:download --json` prints `{ path }` — the extracted `.app` in eas-cli's cache. */
export function parseDownloadPath(stdout: string): Result<string> {
	const parsed = parseJson(stdout, z.object({ path: z.string().min(1) }), "`eas build:download` output");
	return parsed.success ? ok(parsed.data.path) : parsed;
}

export type BuildDecision =
	| { kind: "ready"; build: EasBuild }
	| { kind: "building"; build: EasBuild }
	| { kind: "failed"; build: EasBuild }
	| { kind: "missing" };

const ACTIVE = new Set<EasBuild["status"]>(["NEW", "IN_QUEUE", "IN_PROGRESS"]);
const newestFirst = (a: EasBuild, b: EasBuild) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * What the builds for one fingerprint amount to. A finished build with an archive wins over anything
 * in flight — same hash, same binary. iOS device builds (`isForIosSimulator: false`) never count.
 */
export function decideBuild(builds: readonly EasBuild[], platform: Platform): BuildDecision {
	const sorted = [...builds].sort(newestFirst);
	const usable = (b: EasBuild) => platform !== "ios" || b.isForIosSimulator !== false;
	const ready = sorted.find((b) => usable(b) && b.status === "FINISHED" && Boolean(b.artifacts?.applicationArchiveUrl));
	if (ready) return { kind: "ready", build: ready };
	const building = sorted.find((b) => usable(b) && ACTIVE.has(b.status));
	if (building) return { kind: "building", build: building };
	const failed = sorted.find((b) => usable(b) && (b.status === "ERRORED" || b.status === "CANCELED"));
	if (failed) return { kind: "failed", build: failed };
	return { kind: "missing" };
}

export type PollAction =
	| { kind: "download"; build: EasBuild }
	| { kind: "wait"; reason: string }
	| { kind: "trigger" }
	/** EAS has nothing usable → fall through to a local build */
	| { kind: "miss"; reason: string };

export type PollState = {
	elapsedMs: number;
	/** epoch ms of our `workflow:run`, or null if not triggered */
	triggeredAt: number | null;
};

export type PollPolicy = { timeoutMs: number; graceMs: number; trigger: boolean };

/**
 * One step of the EAS poll loop. Finished → download; in flight → wait (up to `timeoutMs`); missing
 * or failed → trigger the workflow when `trigger` (after `graceMs`, in case CI is about to create
 * it), else miss. A failure newer than our own trigger is final (miss).
 */
export function decidePoll(decision: BuildDecision, state: PollState, policy: PollPolicy): PollAction {
	if (decision.kind === "ready") return { kind: "download", build: decision.build };
	if (
		decision.kind === "failed" &&
		state.triggeredAt !== null &&
		Date.parse(decision.build.createdAt) >= state.triggeredAt
	) {
		return { kind: "miss", reason: `EAS build ${decision.build.id} ${decision.build.status.toLowerCase()}` };
	}
	if (state.elapsedMs >= policy.timeoutMs) {
		return { kind: "miss", reason: `no finished EAS build after ${Math.round(policy.timeoutMs / MINUTE)} min` };
	}
	if (decision.kind === "building") {
		return { kind: "wait", reason: `EAS build ${decision.build.id} is ${decision.build.status.toLowerCase()}` };
	}
	if (state.triggeredAt !== null) return { kind: "wait", reason: "waiting for the triggered workflow's build" };
	const what =
		decision.kind === "failed"
			? `EAS build ${decision.build.id} ${decision.build.status.toLowerCase()}`
			: "no EAS build for this fingerprint";
	if (!policy.trigger) return { kind: "miss", reason: what };
	if (state.elapsedMs < policy.graceMs) return { kind: "wait", reason: `${what} yet — grace period before triggering` };
	return { kind: "trigger" };
}

export function easArgv(...args: string[]): string[] {
	return ["bunx", "eas-cli", ...args, "--json", "--non-interactive"];
}

export function buildListArgv(platform: Platform, profile: string, hash: string): string[] {
	return easArgv(
		"build:list",
		"--platform",
		platform,
		"--build-profile",
		profile,
		"--fingerprint-hash",
		hash,
		...(platform === "ios" ? ["--simulator"] : []),
		"--limit",
		"10"
	);
}

/** Fetch `url` to `dest` (Android `.apk` artifacts). */
export type Download = (url: string, dest: string) => AsyncResult<void>;

export const fetchDownload: Download = async (url, dest) => {
	try {
		const res = await fetch(url);
		if (!res.ok) return err(`GET ${url}: ${res.status}`);
		writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
		return ok(undefined);
	} catch (error) {
		return err(error);
	}
};

export type EasDeps = {
	exec: Exec;
	/** project root (eas-cli reads eas.json/app config from here) */
	cwd: string;
	platform: Platform;
	hash: string;
	eas: EasSettings;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	download?: Download;
	pollMs?: number;
	timeoutMs?: number;
	graceMs?: number;
	/** scratch dir for Android downloads (default: a new tmp dir) */
	tmpDir?: () => string;
};

/** `downloaded` = local path of the artifact (to be moved into the cache). */
export type EasOutcome = { kind: "downloaded"; path: string; buildId: string } | { kind: "miss"; reason: string };

async function run(deps: EasDeps, argv: string[]): AsyncResult<string> {
	const res = await deps.exec(argv, { cwd: deps.cwd, env: { EXPO_NO_TELEMETRY: "1" } });
	return res.exitCode === 0 ? ok(res.stdout) : err(execError(argv, res));
}

async function downloadBuild(deps: EasDeps, build: EasBuild): AsyncResult<string> {
	if (deps.platform === "ios") {
		const out = await run(deps, easArgv("build:download", "--build-id", build.id));
		return out.success ? parseDownloadPath(out.data) : out;
	}
	const url = build.artifacts?.applicationArchiveUrl;
	if (!url) return err(`EAS build ${build.id} has no artifact url`);
	const dir = deps.tmpDir ? deps.tmpDir() : mkdtempSync(join(tmpdir(), "warden-eas-"));
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, `${build.id}.apk`);
	const got = await (deps.download ?? fetchDownload)(url, dest);
	return got.success ? ok(dest) : got;
}

type StepOutcome = EasOutcome | { kind: "continue"; triggered: boolean };

async function listBuilds(deps: EasDeps): AsyncResult<EasBuild[]> {
	const listed = await run(deps, buildListArgv(deps.platform, deps.eas.profile, deps.hash));
	return listed.success ? parseBuildList(listed.data) : listed;
}

/** Carry out one poll action (download / trigger / log the wait). */
async function act(deps: EasDeps, action: PollAction, pollMs: number): Promise<StepOutcome> {
	switch (action.kind) {
		case "download": {
			deps.log(`downloading EAS build ${action.build.id}…`);
			const path = await downloadBuild(deps, action.build);
			if (!path.success) return { kind: "miss", reason: `EAS download failed: ${path.error}` };
			return { kind: "downloaded", path: path.data, buildId: action.build.id };
		}
		case "miss":
			return action;
		case "trigger": {
			const workflow = deps.eas.workflow ?? "";
			deps.log(`no EAS build for ${deps.hash} — triggering ${workflow}`);
			const fired = await run(deps, easArgv("workflow:run", workflow));
			if (!fired.success) return { kind: "miss", reason: `EAS workflow:run failed: ${fired.error}` };
			return { kind: "continue", triggered: true };
		}
		case "wait":
			deps.log(`${action.reason}; checking again in ${Math.round(pollMs / 1000)}s`);
			return { kind: "continue", triggered: false };
	}
}

/**
 * Poll EAS for a build of `hash`: download a finished one, wait for one in flight, trigger the
 * workflow when configured. Any EAS error is a miss (logged) so a local build can still run.
 */
export async function resolveFromEas(deps: EasDeps): Promise<EasOutcome> {
	const policy: PollPolicy = {
		timeoutMs: deps.timeoutMs ?? EAS_TIMEOUT_MS,
		graceMs: deps.graceMs ?? EAS_TRIGGER_GRACE_MS,
		trigger: deps.eas.trigger && deps.eas.workflow !== undefined,
	};
	const pollMs = deps.pollMs ?? EAS_POLL_MS;
	const started = deps.now();
	let triggeredAt: number | null = null;
	for (;;) {
		const builds = await listBuilds(deps);
		if (!builds.success) return { kind: "miss", reason: `EAS unavailable: ${builds.error}` };
		const state = { elapsedMs: deps.now() - started, triggeredAt };
		const outcome = await act(deps, decidePoll(decideBuild(builds.data, deps.platform), state, policy), pollMs);
		if (outcome.kind !== "continue") return outcome;
		if (outcome.triggered) triggeredAt = deps.now();
		await deps.sleep(pollMs);
	}
}
