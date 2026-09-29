import { describe, expect, test } from "bun:test";
import { describeBuild, resolveBuildInfo, sourceDirFromCliPath } from "./build-info";

describe("resolveBuildInfo", () => {
	test("running from source → dev", () => {
		expect(resolveBuildInfo(undefined, "/repo/apps/cli/src/cli.ts", "0.2.0")).toEqual({
			channel: "dev",
			version: "0.2.0",
			sourceDir: "/repo",
		});
	});

	test("compiled with embedded info → that info", () => {
		const embedded = {
			channel: "release",
			version: "0.3.0",
			commit: "abc1234",
			builtAt: "2026-09-29T00:00:00Z",
		} as const;
		expect(resolveBuildInfo(embedded, "/$bunfs/root/warden", "0.2.0")).toEqual(embedded);
	});

	test("compiled without embedded info (plain bun build) → local, unknown source", () => {
		expect(resolveBuildInfo(undefined, "/$bunfs/root/warden", "0.2.0")).toEqual({ channel: "local", version: "0.2.0" });
	});
});

describe("sourceDirFromCliPath", () => {
	test("repo root from apps/cli/src/cli.ts", () => {
		expect(sourceDirFromCliPath("/a/b/apps/cli/src/cli.ts")).toBe("/a/b");
	});
});

describe("describeBuild", () => {
	test("human summary", () => {
		expect(describeBuild({ channel: "dev", version: "0.2.0", sourceDir: "/r" })).toBe("0.2.0 (dev, /r)");
		expect(describeBuild({ channel: "local", version: "0.2.0", sourceDir: "/r", commit: "abc1234-dirty" })).toBe(
			"0.2.0 (local abc1234-dirty, /r)"
		);
		expect(describeBuild({ channel: "release", version: "0.3.0", commit: "abc1234" })).toBe("0.3.0 (release abc1234)");
	});
});
