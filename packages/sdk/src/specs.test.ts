import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { createWardenClient } from "./client";
import { isWardenError } from "./errors";
import { e2eArgs, resolveCliCommand } from "./specs";
import type { CliOutput, SpecsDeps } from "./specs.types";

let dir: string;

beforeEach(async () => {
	({ dir } = await makeSuiteRepo());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REPORT = {
	suite: "mobile",
	platform: "ios",
	isolate: "device",
	ok: true,
	headless: true,
	specs: [],
};

function clientWith(spawn?: SpecsDeps["spawn"]) {
	return createWardenClient(
		{ home: join(dir, ".home"), host: { cwd: join(dir, "src"), env: {} }, cliCommand: ["fake-warden"] },
		spawn ? { specs: { spawn } } : {}
	);
}

describe("specs.list", () => {
	test("suites with their specs", async () => {
		await using warden = clientWith();
		const [suite] = await warden.specs.list();
		expect(suite?.name).toBe("mobile");
		expect(suite?.specs.map((s) => s.id).sort()).toEqual(["chats", "settings"]);
		expect(suite?.specs[0]?.required).toBe(true);
	});

	test("unknown suite -> not_found", async () => {
		await using warden = clientWith();
		const error = await warden.specs.list({ suite: "nope" }).catch((e: unknown) => e);
		expect(isWardenError(error) && error.code).toBe("not_found");
	});

	test("project filter drops other projects", async () => {
		await using warden = clientWith();
		expect(await warden.specs.list({ project: "other" })).toEqual([]);
	});
});

describe("specs.affected", () => {
	test("files -> selection with reasons", async () => {
		await using warden = clientWith();
		const res = await warden.specs.affected({ files: ["settings/form.tsx"] });
		expect(res.suite).toBe("mobile");
		expect(res.platforms[0]?.selected.map((s) => s.id)).toEqual(["settings"]);
		expect(res.platforms[0]?.selected[0]?.reasons[0]?.kind).toBe("import");
	});
});

describe("specs.run", () => {
	test("spawns the CLI with --json, streams stderr, returns the parsed report", async () => {
		const calls: string[][] = [];
		const lines: string[] = [];
		await using warden = clientWith(async (argv, o) => {
			calls.push([...argv]);
			o.onStderrLine("booting");
			return { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: "booting" } satisfies CliOutput;
		});
		const report = await warden.specs.run({
			suite: "mobile",
			specs: ["chats"],
			platform: "ios",
			retry: 1,
			onEvent: (e) => lines.push(e.line),
		});
		expect(report.ok).toBe(true);
		expect(calls[0]).toEqual([
			"fake-warden",
			"e2e",
			"mobile",
			"--json",
			"--specs",
			"chats",
			"--platform",
			"ios",
			"--retry",
			"1",
		]);
		expect(lines).toEqual(["booting"]);
	});

	test("a failed gate still resolves with ok:false", async () => {
		await using warden = clientWith(async () => ({
			exitCode: 1,
			stdout: JSON.stringify({ ...REPORT, ok: false }),
			stderr: "",
		}));
		expect((await warden.specs.run({ suite: "mobile" })).ok).toBe(false);
	});

	test("no report -> failed with stderr", async () => {
		await using warden = clientWith(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
		const error = await warden.specs.run({ suite: "mobile" }).catch((e: unknown) => e);
		expect(isWardenError(error) && error.code).toBe("failed");
		expect(isWardenError(error) && error.details?.stderr).toBe("boom");
	});

	test("abort -> interrupted", async () => {
		const ac = new AbortController();
		await using warden = clientWith(
			(_argv, o) =>
				new Promise((resolve) => {
					o.signal?.addEventListener("abort", () => resolve({ exitCode: 130, stdout: "", stderr: "" }));
				})
		);
		const pending = warden.specs.run({ suite: "mobile" }, { signal: ac.signal }).catch((e: unknown) => e);
		ac.abort();
		const error = await pending;
		expect(isWardenError(error) && error.code).toBe("interrupted");
	});
});

describe("helpers", () => {
	test("e2eArgs all", () => expect(e2eArgs({ suite: "m", all: true })).toEqual(["e2e", "m", "--json", "--all"]));
	test("resolveCliCommand order", () => {
		expect(resolveCliCommand(["x", "y"])).toEqual(["x", "y"]);
		expect(resolveCliCommand(undefined, () => "/bin/warden")).toEqual(["/bin/warden"]);
		expect(
			resolveCliCommand(
				undefined,
				() => null,
				() => true,
				"bun",
				"/m.ts"
			)
		).toEqual(["bun", "/m.ts"]);
		expect(
			resolveCliCommand(
				undefined,
				() => null,
				() => false
			)
		).toEqual(["warden"]);
	});
});
