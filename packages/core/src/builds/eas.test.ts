import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	type BuildDecision,
	buildListArgv,
	decideBuild,
	decidePoll,
	type EasBuild,
	type PollPolicy,
	parseBuildList,
	parseDownloadPath,
	resolveFromEas,
} from "./eas";

const build = (over: Partial<EasBuild> & Pick<EasBuild, "id" | "status">): EasBuild => ({
	createdAt: "2026-09-01T00:00:00.000Z",
	isForIosSimulator: true,
	artifacts: over.status === "FINISHED" ? { applicationArchiveUrl: `https://x/${over.id}.tar.gz` } : null,
	...over,
});

describe("parsing", () => {
	test("parseBuildList accepts eas-cli JSON and ignores extra fields", () => {
		const stdout = JSON.stringify([
			{
				id: "b1",
				status: "FINISHED",
				createdAt: "2026-09-01T00:00:00.000Z",
				platform: "IOS",
				isForIosSimulator: true,
				artifacts: { applicationArchiveUrl: "https://x/b1.tar.gz", buildUrl: "u" },
				project: { id: "p" },
			},
		]);
		const res = parseBuildList(stdout);
		expect(res.success && res.data[0]?.id).toBe("b1");
	});

	test("parseBuildList rejects junk", () => {
		expect(parseBuildList("not json").success).toBe(false);
		expect(parseBuildList(JSON.stringify([{ id: "x", status: "WAT", createdAt: "" }])).success).toBe(false);
	});

	test("parseDownloadPath", () => {
		expect(parseDownloadPath('{"path":"/tmp/eas/App.app"}')).toEqual({ success: true, data: "/tmp/eas/App.app" });
		expect(parseDownloadPath("{}").success).toBe(false);
	});

	test("buildListArgv: --simulator only for iOS", () => {
		expect(buildListArgv("ios", "dev-sim", "h")).toContain("--simulator");
		expect(buildListArgv("android", "dev-sim", "h")).not.toContain("--simulator");
		expect(buildListArgv("ios", "dev-sim", "h").slice(0, 3)).toEqual(["bunx", "eas-cli", "build:list"]);
	});
});

describe("decideBuild", () => {
	test("finished with archive wins over newer in-flight", () => {
		const d = decideBuild(
			[
				build({ id: "new", status: "IN_PROGRESS", createdAt: "2026-09-02T00:00:00Z" }),
				build({ id: "old", status: "FINISHED" }),
			],
			"ios"
		);
		expect(d).toMatchObject({ kind: "ready", build: { id: "old" } });
	});

	test("iOS device builds never count; Android ignores the flag", () => {
		const device = build({ id: "dev", status: "FINISHED", isForIosSimulator: false });
		expect(decideBuild([device], "ios")).toEqual({ kind: "missing" });
		expect(decideBuild([device], "android").kind).toBe("ready");
	});

	test("building / failed / missing", () => {
		expect(decideBuild([build({ id: "q", status: "IN_QUEUE" })], "ios").kind).toBe("building");
		expect(decideBuild([build({ id: "e", status: "ERRORED" })], "ios").kind).toBe("failed");
		expect(decideBuild([build({ id: "f", status: "FINISHED", artifacts: null })], "ios").kind).toBe("missing");
		expect(decideBuild([], "ios").kind).toBe("missing");
	});
});

describe("decidePoll", () => {
	const off: PollPolicy = { timeoutMs: 45 * 60_000, graceMs: 3 * 60_000, trigger: false };
	const on: PollPolicy = { ...off, trigger: true };
	const fresh = { elapsedMs: 0, triggeredAt: null };
	const ready: BuildDecision = { kind: "ready", build: build({ id: "r", status: "FINISHED" }) };
	const building: BuildDecision = { kind: "building", build: build({ id: "b", status: "IN_PROGRESS" }) };
	const failed: BuildDecision = {
		kind: "failed",
		build: build({ id: "f", status: "ERRORED", createdAt: "2026-09-01T00:10:00Z" }),
	};

	test("ready → download", () => {
		expect(decidePoll(ready, fresh, off).kind).toBe("download");
	});

	test("building → wait until timeout, then miss", () => {
		expect(decidePoll(building, fresh, off).kind).toBe("wait");
		expect(decidePoll(building, { elapsedMs: off.timeoutMs, triggeredAt: null }, off).kind).toBe("miss");
	});

	test("missing / failed without trigger → miss immediately (local build next)", () => {
		expect(decidePoll({ kind: "missing" }, fresh, off).kind).toBe("miss");
		expect(decidePoll(failed, fresh, off).kind).toBe("miss");
	});

	test("with trigger: wait out the grace, then trigger, then wait", () => {
		expect(decidePoll({ kind: "missing" }, fresh, on).kind).toBe("wait");
		expect(decidePoll({ kind: "missing" }, { elapsedMs: on.graceMs, triggeredAt: null }, on).kind).toBe("trigger");
		expect(decidePoll({ kind: "missing" }, { elapsedMs: on.graceMs, triggeredAt: 1 }, on).kind).toBe("wait");
	});

	test("failure older than our trigger is retried; newer is final", () => {
		const createdAt = Date.parse("2026-09-01T00:10:00Z");
		expect(decidePoll(failed, { elapsedMs: 0, triggeredAt: createdAt + 1 }, on).kind).toBe("wait");
		expect(decidePoll(failed, { elapsedMs: 0, triggeredAt: createdAt - 1 }, on).kind).toBe("miss");
		expect(decidePoll(failed, { elapsedMs: on.graceMs, triggeredAt: null }, on).kind).toBe("trigger");
	});
});

type Script = Array<Partial<ExecResult>>;

/** exec whose `build:list` answers come from `lists` in order; other eas calls from `others`. */
function easExec(lists: Script, others: Record<string, Partial<ExecResult>>, calls: string[]): Exec {
	let i = 0;
	return async (cmd) => {
		const joined = cmd.join(" ");
		calls.push(joined);
		if (joined.includes("build:list")) {
			const r = lists[Math.min(i++, lists.length - 1)] ?? {};
			return { exitCode: 0, stdout: "", stderr: "", ...r };
		}
		const hit = Object.entries(others).find(([k]) => joined.includes(k));
		return hit ? { exitCode: 0, stdout: "", stderr: "", ...hit[1] } : { exitCode: 127, stdout: "", stderr: "nope" };
	};
}

describe("resolveFromEas", () => {
	const eas = { profile: "development-simulator", trigger: false };
	const list = (...builds: EasBuild[]) => ({ stdout: JSON.stringify(builds) });

	function deps(exec: Exec, over: Partial<Parameters<typeof resolveFromEas>[0]> = {}) {
		let clock = 0;
		const sleeps: number[] = [];
		return {
			sleeps,
			deps: {
				exec,
				cwd: "/repo/app",
				platform: "ios" as const,
				hash: "h",
				eas,
				now: () => clock,
				sleep: async (ms: number) => {
					sleeps.push(ms);
					clock += ms;
				},
				log: () => {},
				pollMs: 30_000,
				...over,
			},
		};
	}

	test("in flight → polls every 30s, then downloads the finished build", async () => {
		const calls: string[] = [];
		const exec = easExec(
			[
				list(build({ id: "b", status: "IN_PROGRESS" })),
				list(build({ id: "b", status: "IN_QUEUE" })),
				list(build({ id: "b", status: "FINISHED" })),
			],
			{ "build:download --build-id b": { stdout: '{"path":"/eas/App.app"}' } },
			calls
		);
		const { deps: d, sleeps } = deps(exec);
		expect(await resolveFromEas(d)).toEqual({ kind: "downloaded", path: "/eas/App.app", buildId: "b" });
		expect(sleeps).toEqual([30_000, 30_000]);
		expect(calls.filter((c) => c.includes("build:list"))).toHaveLength(3);
	});

	test("missing without trigger → miss, no workflow:run", async () => {
		const calls: string[] = [];
		const res = await resolveFromEas(deps(easExec([list()], {}, calls)).deps);
		expect(res.kind).toBe("miss");
		expect(calls.some((c) => c.includes("workflow:run"))).toBe(false);
	});

	test("missing with trigger + workflow → triggers once, waits, downloads", async () => {
		const calls: string[] = [];
		const exec = easExec(
			[list(), list(), list(build({ id: "n", status: "IN_PROGRESS" })), list(build({ id: "n", status: "FINISHED" }))],
			{
				"workflow:run .eas/workflows/dev-build.yml": { stdout: "{}" },
				"build:download": { stdout: '{"path":"/eas/New.app"}' },
			},
			calls
		);
		const res = await resolveFromEas(
			deps(exec, { eas: { profile: "p", workflow: ".eas/workflows/dev-build.yml", trigger: true }, graceMs: 30_000 })
				.deps
		);
		expect(res).toEqual({ kind: "downloaded", path: "/eas/New.app", buildId: "n" });
		expect(calls.filter((c) => c.includes("workflow:run"))).toHaveLength(1);
	});

	test("eas-cli failure → miss (local build can still run)", async () => {
		const exec = easExec([{ exitCode: 1, stderr: "Not logged in" }], {}, []);
		const res = await resolveFromEas(deps(exec).deps);
		expect(res.kind).toBe("miss");
		if (res.kind === "miss") expect(res.reason).toContain("Not logged in");
	});

	test("Android downloads the artifact url", async () => {
		const got: string[] = [];
		const exec = easExec([list(build({ id: "a", status: "FINISHED", isForIosSimulator: null }))], {}, []);
		const res = await resolveFromEas(
			deps(exec, {
				platform: "android",
				tmpDir: () => "/tmp/warden-eas-test",
				download: async (url, dest) => {
					got.push(`${url} -> ${dest}`);
					return { success: true, data: undefined };
				},
			}).deps
		);
		expect(res).toEqual({ kind: "downloaded", path: "/tmp/warden-eas-test/a.apk", buildId: "a" });
		expect(got).toEqual(["https://x/a.tar.gz -> /tmp/warden-eas-test/a.apk"]);
	});
});
