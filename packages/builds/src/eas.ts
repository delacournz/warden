import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { easBuildSchema } from "@delacour/warden-config/eas.schema";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { z } from "zod";
import { EAS_POLL_MS, EAS_TIMEOUT_MS, EAS_TRIGGER_GRACE_MS } from "./builds.defaults";
import type { EasSettings } from "./config";

const MINUTE = 60_000;

type EasSchemas = typeof import("@delacour/warden-config/eas.schema");

export type EasBuild = z.infer<typeof easBuildSchema>;

export type BuildDecision =
	| { kind: "ready"; build: EasBuild }
	| { kind: "building"; build: EasBuild }
	| { kind: "failed"; build: EasBuild }
	| { kind: "missing" };

const ACTIVE = new Set<EasBuild["status"]>(["NEW", "IN_QUEUE", "IN_PROGRESS"]);

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

/** Fetch `url` to `dest` (Android `.apk` artifacts). */
export type Download = (url: string, dest: string) => AsyncResult<void>;

export type EasDeps = {
	exec: Exec;
	/** project root (eas-cli reads eas.json/app config from here) */
	cwd: string;
	platform: Platform;
	hash: string;
	/** look builds up by this git commit instead of the fingerprint (JS-aware projects); never triggers the workflow */
	commit?: string;
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

type StepOutcome = EasOutcome | { kind: "continue"; triggered: boolean };

/**
 * Pure EAS helpers: parsers for `eas-cli` output, the build / poll decisions and the argv builders. Callers use the
 * `eas` singleton; the schemas load on the first parse so zod stays off the start path (15-2).
 */
export class Eas {
	/** The schemas (`eas.schema.ts`), loaded on the first parse; sync like the parsers. */
	private schemas: EasSchemas | undefined;

	parseBuildList(stdout: string): Result<EasBuild[]> {
		return this.parseJson(stdout, this.easSchemas().easBuildListSchema, "`eas build:list` output");
	}

	/** `eas build:download --json` prints `{ path }` — the extracted `.app` in eas-cli's cache. */
	parseDownloadPath(stdout: string): Result<string> {
		const parsed = this.parseJson(stdout, this.easSchemas().easDownloadSchema, "`eas build:download` output");
		return parsed.success ? resultFactory.ok(parsed.data.path) : parsed;
	}

	/**
	 * What the builds for one fingerprint amount to. A finished build with an archive wins over anything
	 * in flight — same hash, same binary. iOS device builds (`isForIosSimulator: false`) never count.
	 */
	decideBuild(builds: readonly EasBuild[], platform: Platform): BuildDecision {
		const sorted = [...builds].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
		const usable = (b: EasBuild) => platform !== "ios" || b.isForIosSimulator !== false;
		const ready = sorted.find(
			(b) => usable(b) && b.status === "FINISHED" && Boolean(b.artifacts?.applicationArchiveUrl)
		);
		if (ready) return { kind: "ready", build: ready };
		const building = sorted.find((b) => usable(b) && ACTIVE.has(b.status));
		if (building) return { kind: "building", build: building };
		const failed = sorted.find((b) => usable(b) && (b.status === "ERRORED" || b.status === "CANCELED"));
		if (failed) return { kind: "failed", build: failed };
		return { kind: "missing" };
	}

	/**
	 * One step of the EAS poll loop. Finished → download; in flight → wait (up to `timeoutMs`); missing
	 * or failed → trigger the workflow when `trigger` (after `graceMs`, in case CI is about to create
	 * it), else miss. A failure newer than our own trigger is final (miss).
	 */
	decidePoll(decision: BuildDecision, state: PollState, policy: PollPolicy): PollAction {
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
		if (state.elapsedMs < policy.graceMs)
			return { kind: "wait", reason: `${what} yet — grace period before triggering` };
		return { kind: "trigger" };
	}

	argv(...args: string[]): string[] {
		return ["bunx", "eas-cli", ...args, "--json", "--non-interactive"];
	}

	/** `eas build:list` for one fingerprint hash, or — JS-aware projects — for the builds of one git `commit`. */
	buildListArgv(platform: Platform, profile: string, hash: string, commit?: string): string[] {
		return this.argv(
			"build:list",
			"--platform",
			platform,
			"--build-profile",
			profile,
			...(commit !== undefined ? ["--git-commit-hash", commit] : ["--fingerprint-hash", hash]),
			...(platform === "ios" ? ["--simulator"] : []),
			"--limit",
			"10"
		);
	}

	/** The default `Download`: a plain `fetch` written to `dest`. */
	readonly fetchDownload: Download = async (url, dest) => {
		try {
			const res = await fetch(url);
			if (!res.ok) return resultFactory.err(`GET ${url}: ${res.status}`);
			writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
			return resultFactory.ok(undefined);
		} catch (error) {
			return resultFactory.err(error);
		}
	};

	private easSchemas(): EasSchemas {
		this.schemas ??= require("@delacour/warden-config/eas.schema") as EasSchemas;
		return this.schemas;
	}

	private parseJson<T>(stdout: string, schema: z.ZodType<T>, what: string): Result<T> {
		try {
			const parsed = schema.safeParse(JSON.parse(stdout));
			if (parsed.success) return resultFactory.ok(parsed.data);
			return resultFactory.err(`unexpected ${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
		} catch {
			return resultFactory.err(`unexpected ${what}: not JSON: ${stdout.trim().slice(0, 200)}`);
		}
	}
}

export const eas = new Eas();

/**
 * Poll EAS for a build of `deps.hash`: instance class over one `EasDeps` bag; `resolve()` downloads a finished
 * build, waits for one in flight, or triggers the workflow when configured. Any EAS error is a miss (logged) so a
 * local build can still run.
 */
export class EasResolver {
	constructor(private readonly deps: EasDeps) {}

	async resolve(): Promise<EasOutcome> {
		const { deps } = this;
		const policy: PollPolicy = {
			timeoutMs: deps.timeoutMs ?? EAS_TIMEOUT_MS,
			graceMs: deps.graceMs ?? EAS_TRIGGER_GRACE_MS,
			trigger: deps.commit === undefined && deps.eas.trigger && deps.eas.workflow !== undefined,
		};
		const pollMs = deps.pollMs ?? EAS_POLL_MS;
		const started = deps.now();
		let triggeredAt: number | null = null;
		for (;;) {
			const builds = await this.listBuilds();
			if (!builds.success) return { kind: "miss", reason: `EAS unavailable: ${builds.error}` };
			const state = { elapsedMs: deps.now() - started, triggeredAt };
			const action = eas.decidePoll(eas.decideBuild(builds.data, deps.platform), state, policy);
			const outcome = await this.act(action, pollMs);
			if (outcome.kind !== "continue") return outcome;
			if (outcome.triggered) triggeredAt = deps.now();
			await deps.sleep(pollMs);
		}
	}

	private async run(argv: string[]): AsyncResult<string> {
		const res = await this.deps.exec(argv, { cwd: this.deps.cwd, env: { EXPO_NO_TELEMETRY: "1" } });
		return res.exitCode === 0 ? resultFactory.ok(res.stdout) : resultFactory.err(execErrors.format(argv, res));
	}

	private async downloadBuild(build: EasBuild): AsyncResult<string> {
		const { deps } = this;
		if (deps.platform === "ios") {
			const out = await this.run(eas.argv("build:download", "--build-id", build.id));
			return out.success ? eas.parseDownloadPath(out.data) : out;
		}
		const url = build.artifacts?.applicationArchiveUrl;
		if (!url) return resultFactory.err(`EAS build ${build.id} has no artifact url`);
		const dir = deps.tmpDir ? deps.tmpDir() : mkdtempSync(join(tmpdir(), "warden-eas-"));
		mkdirSync(dir, { recursive: true });
		const dest = join(dir, `${build.id}.apk`);
		const got = await (deps.download ?? eas.fetchDownload)(url, dest);
		return got.success ? resultFactory.ok(dest) : got;
	}

	private async listBuilds(): AsyncResult<EasBuild[]> {
		const { deps } = this;
		const listed = await this.run(eas.buildListArgv(deps.platform, deps.eas.profile, deps.hash, deps.commit));
		return listed.success ? eas.parseBuildList(listed.data) : listed;
	}

	/** Carry out one poll action (download / trigger / log the wait). */
	private async act(action: PollAction, pollMs: number): Promise<StepOutcome> {
		const { deps } = this;
		switch (action.kind) {
			case "download": {
				deps.log(`downloading EAS build ${action.build.id}…`);
				const path = await this.downloadBuild(action.build);
				if (!path.success) return { kind: "miss", reason: `EAS download failed: ${path.error}` };
				return { kind: "downloaded", path: path.data, buildId: action.build.id };
			}
			case "miss":
				return action;
			case "trigger": {
				const workflow = deps.eas.workflow ?? "";
				deps.log(`no EAS build for ${deps.hash} — triggering ${workflow}`);
				const fired = await this.run(eas.argv("workflow:run", workflow));
				if (!fired.success) return { kind: "miss", reason: `EAS workflow:run failed: ${fired.error}` };
				return { kind: "continue", triggered: true };
			}
			case "wait":
				deps.log(`${action.reason}; checking again in ${Math.round(pollMs / 1000)}s`);
				return { kind: "continue", triggered: false };
		}
	}
}
