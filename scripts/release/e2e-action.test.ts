import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The e2e composite action's artifact collection (`.github/actions/e2e/artifacts.sh`), run under the macOS system
 * bash (3.2) against a stub `warden`, plus the action's shape: one upload step per group. A group that is collected
 * but never uploaded, or a script that needs bash 4, fails here rather than on a customer's runner. `app` and
 * `golden` are tarballs: upload-artifact drops the executable bit and follows symlinks, so a raw `.app` would not
 * launch and a raw golden would not import.
 */
const ROOT = join(import.meta.dir, "..", "..");
const ACTION_DIR = join(ROOT, ".github", "actions", "e2e");
const SCRIPT = join(ACTION_DIR, "artifacts.sh");
const GROUPS = ["report", "batches", "logs", "app", "golden"] as const;
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

type Group = (typeof GROUPS)[number];
type Collected = { groups: Group[]; paths: Record<Group, string[]>; archived: boolean; stdout: string };
type RunOpts = {
	artifacts: string;
	passed: boolean;
	goldenBuilt?: boolean;
	goldenArchived?: boolean;
	goldenCacheHit?: boolean;
};

const STUB = `#!/bin/sh
case "$1 $2" in
  "golden key") echo '{"name":"g-1"}' ;;
  "golden ls") if [ "$STUB_BUILT" = 1 ]; then echo '[{"name":"g-1"}]'; else echo '[]'; fi ;;
  "golden export") mkdir -p "$3/g-1" && echo '{}' > "$3/g-1/golden.json" && ln -s /nowhere/data "$3/g-1/link" && echo "exported" ;;
  "builds ls") echo '{"builds":[{"path":"'"$HOME"'/old.app","size":1,"lastUsedAt":1000},{"path":"'"$HOME"'/.warden/builds/p/base/X.app","size":1,"lastUsedAt":9999999999000},{"path":"'"$HOME"'/.warden/builds/p/repack/X.app","size":1,"lastUsedAt":9999999999000},{"path":"'"$HOME"'/.warden/builds/p/base/X.app","size":0,"lastUsedAt":9999999999000}]}' ;;
esac
`;

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-artifacts-"));
	mkdirSync(join(home, "bin"));
	mkdirSync(join(home, ".warden", "batches"), { recursive: true });
	mkdirSync(join(home, ".warden", "logs"), { recursive: true });
	writeFileSync(join(home, "report.json"), "{}");
	writeFileSync(join(home, "old.app"), "");
	mkdirSync(join(home, ".warden", "builds", "p", "base", "X.app"), { recursive: true });
	mkdirSync(join(home, ".warden", "builds", "p", "repack", "X.app"), { recursive: true });
	writeFileSync(join(home, ".warden", "builds", "p", "base", "X.app", "X"), "base");
	chmodSync(join(home, ".warden", "builds", "p", "base", "X.app", "X"), 0o755);
	writeFileSync(join(home, ".warden", "builds", "p", "repack", "X.app", "X"), "repack");
	writeFileSync(join(home, "bin", "warden"), STUB);
	chmodSync(join(home, "bin", "warden"), 0o755);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function tarList(file: string, verbose = false): string[] {
	const proc = Bun.spawnSync(["tar", verbose ? "-tvf" : "-tf", file]);
	expect(proc.exitCode).toBe(0);
	return proc.stdout.toString().split("\n").filter(Boolean);
}

function collect(opts: RunOpts): Collected {
	if (opts.goldenArchived === true) {
		mkdirSync(join(home, "warden-goldens", "g-1"), { recursive: true });
		writeFileSync(join(home, "warden-goldens", "g-1", "golden.json"), "{}");
		symlinkSync("/nowhere/data", join(home, "warden-goldens", "g-1", "link"));
	}
	const output = join(home, "github-output");
	writeFileSync(output, "");
	const proc = Bun.spawnSync([BASH, SCRIPT], {
		env: {
			HOME: home,
			PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
			RUNNER_TEMP: home,
			GITHUB_OUTPUT: output,
			ARTIFACTS: opts.artifacts,
			PASSED: opts.passed ? "true" : "false",
			REPORT: join(home, "report.json"),
			STARTED: "2000",
			PROFILE: "",
			STUB_BUILT: opts.goldenBuilt === true ? "1" : "0",
			GOLDEN_CACHE_HIT: opts.goldenCacheHit === true ? "true" : "",
		},
	});
	expect(proc.exitCode).toBe(0);
	const lines = readFileSync(output, "utf8").split("\n");
	const value = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
	const groups = value("groups");
	return {
		groups: groups === "" ? [] : (groups.split(",") as Group[]),
		paths: JSON.parse(value("paths")) as Record<Group, string[]>,
		archived: value("golden-archived") === "true",
		stdout: proc.stdout.toString(),
	};
}

describe("artifacts.sh", () => {
	test("all after a green run collects every group, the golden already archived", () => {
		const run = collect({ artifacts: "all", passed: true, goldenBuilt: true, goldenArchived: true });
		expect(run.groups).toEqual([...GROUPS]);
		expect(run.paths.golden).toEqual([join(home, "warden-artifacts", "golden.tar")]);
		expect(run.archived).toBe(true);
		expect(run.stdout).not.toContain("exported");
	});

	test("all after a failed run collects report, batches, logs and golden, not app", () => {
		const run = collect({ artifacts: "all", passed: false, goldenBuilt: true });
		expect(run.groups).toEqual(["report", "batches", "logs", "golden"]);
		expect(run.paths.logs).toEqual([join(home, ".warden", "logs")]);
		expect(run.paths.app).toEqual([]);
	});

	test("all after a green run skips a golden restored from the cache: the cache already holds those bytes", () => {
		const run = collect({
			artifacts: "all",
			passed: true,
			goldenBuilt: true,
			goldenArchived: true,
			goldenCacheHit: true,
		});
		expect(run.groups).toEqual(["report", "batches", "logs", "app"]);
		expect(run.paths.golden).toEqual([]);
		expect(existsSync(join(home, "warden-artifacts", "golden.tar"))).toBe(false);
	});

	test("all after a failed run keeps a golden restored from the cache: it reproduces the failure", () => {
		const run = collect({
			artifacts: "all",
			passed: false,
			goldenBuilt: true,
			goldenArchived: true,
			goldenCacheHit: true,
		});
		expect(run.paths.golden).toEqual([join(home, "warden-artifacts", "golden.tar")]);
	});

	test("an explicit golden in the list is collected after a green run, cache hit or not", () => {
		const run = collect({
			artifacts: "golden",
			passed: true,
			goldenBuilt: true,
			goldenArchived: true,
			goldenCacheHit: true,
		});
		expect(run.paths.golden).toEqual([join(home, "warden-artifacts", "golden.tar")]);
	});

	test("logs are always collected, whatever the artifacts input says", () => {
		const logs = [join(home, ".warden", "logs")];
		for (const passed of [true, false]) {
			expect(collect({ artifacts: "none", passed }).paths.logs).toEqual(logs);
			expect(collect({ artifacts: "report", passed }).paths.logs).toEqual(logs);
		}
	});

	test("a golden built but not archived is exported, once", () => {
		const run = collect({ artifacts: "golden", passed: true, goldenBuilt: true });
		expect(run.stdout).toContain("exported");
		expect(run.archived).toBe(true);
		expect(existsSync(join(home, "warden-goldens", "g-1", "golden.json"))).toBe(true);
	});

	test("a golden never built is skipped, not built to upload it", () => {
		const run = collect({ artifacts: "all", passed: false, goldenBuilt: false });
		expect(run.groups).toEqual(["report", "batches", "logs"]);
		expect(run.archived).toBe(false);
		expect(run.stdout).toContain("never built");
	});

	test("app tars only the builds the run used, paths kept so same-named apps never clash, modes kept", () => {
		const run = collect({ artifacts: "app", passed: true });
		expect(run.paths.app).toEqual([join(home, "warden-artifacts", "app.tar")]);
		const entries = tarList(run.paths.app[0] ?? "");
		expect(entries).toContain(".warden/builds/p/base/X.app/X");
		expect(entries).toContain(".warden/builds/p/repack/X.app/X");
		expect(entries.some((e) => e.includes("old.app"))).toBe(false);
		const base = tarList(run.paths.app[0] ?? "", true).find((l) => l.endsWith("base/X.app/X"));
		expect(base?.startsWith("-rwx")).toBe(true);
	});

	test("golden is a tarball of its archive dir that keeps symlinks, ready for warden golden import", () => {
		const run = collect({ artifacts: "golden", passed: true, goldenBuilt: true, goldenArchived: true });
		const listing = tarList(run.paths.golden[0] ?? "", true);
		expect(listing.some((l) => l.endsWith("g-1/golden.json"))).toBe(true);
		expect(listing.some((l) => l.startsWith("l") && l.includes("g-1/link -> /nowhere/data"))).toBe(true);
	});

	test("a list picks groups, spaces allowed; none collects only the logs", () => {
		expect(collect({ artifacts: "report, batches", passed: false }).groups).toEqual(["report", "batches", "logs"]);
		const none = collect({ artifacts: "none", passed: true, goldenBuilt: true });
		expect(none.groups).toEqual(["logs"]);
		expect(Object.values(none.paths).flat()).toEqual([join(home, ".warden", "logs")]);
	});
});

describe("action.yml artifacts", () => {
	type Step = { name?: string; id?: string; if?: string; uses?: string; with?: Record<string, string> };
	type Action = {
		inputs: Record<string, { default?: string }>;
		outputs: Record<string, unknown>;
		runs: { steps: Step[] };
	};
	const action = Bun.YAML.parse(readFileSync(join(ACTION_DIR, "action.yml"), "utf8")) as Action;

	test("defaults to collecting and uploading everything", () => {
		expect(action.inputs.artifacts?.default).toBe("all");
		expect(action.inputs["upload-artifacts"]?.default).toBe("true");
		expect(Object.keys(action.outputs)).toEqual(expect.arrayContaining(["artifact-groups", "artifact-paths"]));
	});

	test("uploads each group as its own artifact, gated on the collected groups", () => {
		const steps = action.runs.steps;
		const collectIndex = steps.findIndex((s) => s.id === "artifacts");
		expect(collectIndex).toBeGreaterThan(steps.findIndex((s) => s.id === "run"));
		for (const group of GROUPS) {
			const upload = steps.find(
				(s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name?.endsWith(`-${group}`)
			);
			expect(upload, group).toBeDefined();
			expect(upload?.if).toContain(`',${group},'`);
			expect(upload?.if).toContain("inputs.upload-artifacts == 'true'");
			expect(upload?.with?.path).toBe(`\${{ steps.artifacts.outputs.${group} }}`);
		}
	});

	test("the collection knows whether the golden came from the cache", () => {
		const collectStep = action.runs.steps.find((s) => s.id === "artifacts") as Step & { env?: Record<string, string> };
		expect(collectStep.env?.GOLDEN_CACHE_HIT).toBe(`\${{ steps.golden-cache.outputs.cache-hit }}`);
	});

	test("the cache export reuses the golden the collection archived", () => {
		const steps = action.runs.steps;
		const exportIndex = steps.findIndex((s) => s.id === "golden-export");
		expect(steps.findIndex((s) => s.id === "artifacts")).toBeLessThan(exportIndex);
		expect(JSON.stringify(steps[exportIndex])).toContain("steps.artifacts.outputs.golden-archived");
	});
});
