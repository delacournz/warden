import { afterEach, describe, expect, test } from "bun:test";
import type { RunnerBuild, RunnerBuildError } from "@delacour/warden-core/ios-runner/runner-build.types";
import { type TestContext, testContext } from "../testing";
import type { BuildInfo } from "../update/build-info";
import { createRunnerBuild, describeBuildError, type EnsureRunnerBuild } from "./build-port";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const BUILT: RunnerBuild = {
	xctestrun: "/c/x.xctestrun",
	derivedData: "/c/dd",
	bundleId: "nz.example.runner",
	team: "ABCDE12345",
	teamSource: "config",
	cached: true,
};

function port(ensure: EnsureRunnerBuild, build: BuildInfo, seen: Parameters<EnsureRunnerBuild>[0][] = []) {
	ctx = testContext([]);
	return createRunnerBuild(ctx, {
		ensure: async (input) => {
			seen.push(input);
			return ensure(input);
		},
		build: () => build,
		iosConfig: () => ({ teamId: "ABCDE12345", runnerBundleId: "nz.example.runner" }),
	});
}

describe("createRunnerBuild", () => {
	test("passes udid, version, config team and bundle id, and returns just the artifacts", async () => {
		const seen: Parameters<EnsureRunnerBuild>[0][] = [];
		const p = port(async () => ({ success: true, data: BUILT }), { channel: "release", version: "1.2.3" }, seen);
		const res = await p.ensure({ udid: "U", env: { A: "1" } });
		expect(res).toEqual({
			success: true,
			data: { xctestrun: "/c/x.xctestrun", derivedData: "/c/dd", bundleId: "nz.example.runner" },
		});
		expect(seen[0]).toMatchObject({
			udid: "U",
			version: "1.2.3",
			configTeamId: "ABCDE12345",
			configBundleId: "nz.example.runner",
			env: { A: "1" },
		});
	});

	test("from source the runner sources are the checkout's; in a binary the embedded blob", async () => {
		const sources: string[] = [];
		const seen: Parameters<EnsureRunnerBuild>[0][] = [];
		const p = port(
			async () => ({ success: true, data: BUILT }),
			{ channel: "dev", version: "1", sourceDir: "/nope/repo" },
			seen
		);
		await p.ensure({ udid: "U", env: {} });
		const loaded = await seen[0]?.loadSources();
		sources.push(loaded?.success ? "ok" : (loaded?.error ?? ""));
		expect(sources[0]).toContain("/nope/repo/packages/e2e/native");
		const seen2: Parameters<EnsureRunnerBuild>[0][] = [];
		const p2 = port(async () => ({ success: true, data: BUILT }), { channel: "release", version: "1" }, seen2);
		await p2.ensure({ udid: "U", env: {} });
		const embedded = await seen2[0]?.loadSources();
		expect(embedded?.success === false && embedded.error).toContain("no embedded iOS runner sources");
	});

	test("a build error becomes E_<CODE> with message and hint", async () => {
		const error: RunnerBuildError = { code: "no_team", message: "no signing team", hint: "set ios.teamId" };
		const p = port(async () => ({ success: false, error }), { channel: "release", version: "1" });
		expect(await p.ensure({ udid: "U", env: {} })).toEqual({
			success: false,
			error: { code: "E_NO_TEAM", message: "no signing team set ios.teamId" },
		});
	});
});

describe("describeBuildError", () => {
	test("team ambiguity lists the teams", () => {
		const described = describeBuildError({
			code: "ios_team_ambiguous",
			message: "two teams",
			hint: "pick one",
			teams: [
				{ teamId: "AAAAAAAAAA", identities: [] },
				{ teamId: "BBBBBBBBBB", identities: [] },
			],
		});
		expect(described.code).toBe("E_IOS_TEAM_AMBIGUOUS");
		expect(described.message).toBe("two teams Teams: AAAAAAAAAA, BBBBBBBBBB. pick one");
	});
});
