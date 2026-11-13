import { describe, expect, test } from "bun:test";
import { createProvider, type WardenRun } from "./expo-build-cache";

type Call = { args: readonly string[]; cwd: string };

function setup(reply: (args: readonly string[]) => Partial<WardenRun> | Error) {
	const calls: Call[] = [];
	const logs: string[] = [];
	const warnings: string[] = [];
	const provider = createProvider({
		run: async (args, cwd) => {
			calls.push({ args, cwd });
			const r = reply(args);
			if (r instanceof Error) throw r;
			return { exitCode: 0, stdout: "", stderr: "", ...r };
		},
		log: (m) => logs.push(m),
		warn: (m) => warnings.push(m),
	});
	return { provider, calls, logs, warnings };
}

const json = (doc: object, exitCode = 0): Partial<WardenRun> => ({ exitCode, stdout: JSON.stringify(doc) });
const ROOT = "/work/app";
const IOS = { projectRoot: ROOT, platform: "ios", runOptions: {} } as const;

describe("calculateFingerprintHash", () => {
	test("warden's dev hash for an iOS Debug run, asked in the project root", async () => {
		const { provider, calls } = setup(() => json({ found: false, hash: "fp:dev", defaultBuild: true }, 2));
		expect(await provider.calculateFingerprintHash(IOS)).toBe("fp:dev");
		expect(calls).toEqual([{ args: ["builds", "path", "ios", "--kind", "dev", "--json"], cwd: ROOT }]);
		for (const configuration of ["Debug", "DebugStaging"]) {
			expect(await provider.calculateFingerprintHash({ ...IOS, runOptions: { configuration } })).toBe("fp:dev");
		}
	});

	test("a Release configuration or android: null, warden never runs", async () => {
		const { provider, calls } = setup(() => json({}));
		expect(await provider.calculateFingerprintHash({ ...IOS, runOptions: { configuration: "Release" } })).toBeNull();
		expect(
			await provider.calculateFingerprintHash({ ...IOS, platform: "android", runOptions: { variant: "debug" } })
		).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a project whose native build is not warden's default dev build: null, one line saying why", async () => {
		const { provider, logs, warnings } = setup(() => json({ found: true, hash: "fp:dev", defaultBuild: false }));
		expect(await provider.calculateFingerprintHash(IOS)).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("warden:");
		expect(logs[0]).toContain("default dev build");
		expect(warnings).toEqual([]);
	});

	test("warden missing, failing or printing junk: null with one warning, never a throw", async () => {
		const replies: Array<Partial<WardenRun> | Error> = [
			{ exitCode: null, failure: "could not run warden (spawn warden ENOENT)" },
			{ exitCode: 1, stderr: "\nwarden builds path: no such project\n" },
			{ exitCode: 0, stdout: "not json" },
			{ exitCode: 0, stdout: JSON.stringify({ found: false }) },
			new Error("boom"),
		];
		for (const reply of replies) {
			const { provider, warnings } = setup(() => reply);
			expect(await provider.calculateFingerprintHash(IOS)).toBeNull();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("warden:");
		}
	});
});

describe("resolveBuildCache", () => {
	const props = { ...IOS, fingerprintHash: "fp:dev" } as const;

	test("a hit returns the cached .app", async () => {
		const { provider, calls, logs } = setup(() =>
			json({ found: true, hash: "fp:dev", path: "/cache/App.app", platform: "ios", kind: "dev", defaultBuild: true })
		);
		expect(await provider.resolveBuildCache(props)).toBe("/cache/App.app");
		expect(calls).toEqual([
			{ args: ["builds", "path", "ios", "--kind", "dev", "--hash", "fp:dev", "--json"], cwd: ROOT },
		]);
		expect(logs[0]).toContain("/cache/App.app");
	});

	test("a miss (exit 2) is null with a log line, not a warning", async () => {
		const { provider, logs, warnings } = setup(() => json({ found: false, hash: "fp:dev", defaultBuild: true }, 2));
		expect(await provider.resolveBuildCache(props)).toBeNull();
		expect(logs).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	test("any other failure is null with a warning", async () => {
		const { provider, warnings } = setup(() => ({ exitCode: 1, stderr: "warden builds path: bad hash" }));
		expect(await provider.resolveBuildCache(props)).toBeNull();
		expect(warnings).toEqual(["warden: could not look up the cached dev build: warden builds path: bad hash"]);
	});
});

describe("uploadBuildCache", () => {
	const props = { ...IOS, fingerprintHash: "fp:dev", buildPath: "/build/App.app" } as const;

	test("files the build and returns the stored path", async () => {
		const { provider, calls, logs } = setup(() => json({ kind: "dev", hash: "fp:dev", path: "/cache/App.app" }));
		expect(await provider.uploadBuildCache(props)).toBe("/cache/App.app");
		expect(calls).toEqual([
			{ args: ["builds", "import", "/build/App.app", "--kind", "dev", "--hash", "fp:dev", "--json"], cwd: ROOT },
		]);
		expect(logs).toHaveLength(1);
	});

	test("a refused import is null with a warning", async () => {
		const { provider, warnings } = setup(() => ({
			exitCode: 1,
			stderr: "warden builds import: App.app embeds main.jsbundle",
		}));
		expect(await provider.uploadBuildCache(props)).toBeNull();
		expect(warnings).toEqual([
			"warden: could not store the dev build: warden builds import: App.app embeds main.jsbundle",
		]);
	});
});
