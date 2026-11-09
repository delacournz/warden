import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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

/** Each run spawns bash, tar and the stub warden: 1-3 s on a loaded CI runner, past bun's 5 s default when cold. */
setDefaultTimeout(30_000);

type Group = (typeof GROUPS)[number];
type Collected = { groups: Group[]; paths: Record<Group, string[]>; archived: boolean; stdout: string };
type RunOpts = {
	artifacts: string;
	passed: boolean;
	goldenBuilt?: boolean;
	goldenArchived?: boolean;
	goldenCacheHit?: boolean;
	/** the suite runs without a golden: the action passes an empty GOLDEN_KEY */
	goldenOff?: boolean;
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
			...(opts.goldenOff === true ? { GOLDEN_KEY: "" } : {}),
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

	test("all for a suite without a golden never looks for one, green or failed", () => {
		const green = collect({ artifacts: "all", passed: true, goldenOff: true });
		expect(green.stdout).not.toContain("never built");
		expect(green.groups).toEqual(["report", "batches", "logs", "app"]);
		expect(collect({ artifacts: "all", passed: false, goldenOff: true }).groups).toEqual(["report", "batches", "logs"]);
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

	test("the device helpers' logs join the logs group, their sockets left behind", () => {
		const simd = join(home, ".warden", "simd");
		mkdirSync(simd, { recursive: true });
		writeFileSync(join(simd, "U1.log"), "helper log");
		writeFileSync(join(simd, "U1.sock"), "");
		const run = collect({ artifacts: "none", passed: true });
		const copied = join(home, "warden-artifacts", "simd-logs");
		expect(run.paths.logs).toEqual([join(home, ".warden", "logs"), copied]);
		expect(readFileSync(join(copied, "U1.log"), "utf8")).toBe("helper log");
		expect(existsSync(join(copied, "U1.sock"))).toBe(false);
	});

	test("no helper logs: the logs group is warden's logs alone", () => {
		expect(collect({ artifacts: "none", passed: true }).paths.logs).toEqual([join(home, ".warden", "logs")]);
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

	test("a native build cache miss says so, installs ccache and restores the newest compiler cache by prefix", () => {
		const steps = action.runs.steps;
		const at = (id: string) => steps.findIndex((s) => s.id === id);
		const prep = steps[at("ccache-prep")] as Step & { run?: string };
		expect(at("builds-cache")).toBeLessThan(at("ccache-cache"));
		expect(prep.if).toContain("steps.builds-cache.outputs.cache-hit != 'true'");
		expect(prep.if).toContain("inputs.compiler-cache == 'true'");
		expect(steps[at("ccache-cache")]?.if).toBe(prep.if);
		// a pinned, checksum-verified release binary first; Homebrew only when that download fails
		expect(prep.run).toMatch(/version=\d+\.\d+\.\d+\n/);
		expect(prep.run).toMatch(/sha256=[0-9a-f]{64}\n/);
		expect(prep.run).toContain("shasum -a 256 -c -");
		expect(prep.run).toContain("https://github.com/ccache/ccache/releases/download/");
		expect(prep.run?.indexOf("shasum")).toBeLessThan(prep.run?.indexOf("install -m 0755") ?? -1);
		expect(prep.run?.indexOf("curl")).toBeLessThan(prep.run?.indexOf("brew install ccache") ?? -1);
		expect(prep.run).toContain("ccache --zero-stats");
		const notice = steps[at("cache-miss")] as Step & { run?: string };
		expect(notice.if).toContain("steps.builds-cache.outputs.cache-hit != 'true'");
		expect(notice.if).not.toContain("compiler-cache");
		expect(notice.run).toContain("::notice title=native build cache miss::");
		expect(at("cache-miss")).toBeLessThan(at("run"));
		const restore = steps[at("ccache-cache")];
		expect(restore?.uses).toStartWith("actions/cache/restore@");
		// a per-run key never hits exactly, so restore-keys pick the newest save: an empty save cannot pin the cache
		expect(restore?.with?.key).toBe(
			`\${{ steps.keys.outputs.ccache }}-\${{ github.run_id }}-\${{ github.run_attempt }}`
		);
		expect(restore?.with?.["restore-keys"]).toBe(`\${{ steps.keys.outputs.ccache-restore }}`);
		expect(at("ccache-cache")).toBeLessThan(at("ccache-prep"));
		expect(at("ccache-prep")).toBeLessThan(at("run"));
		expect(action.inputs["compiler-cache"]?.default).toBe("true");
	});

	test("warden doctor checks the host after ccache is installed, before anything uses the helper", () => {
		const steps = action.runs.steps;
		const at = (id: string) => steps.findIndex((s) => s.id === id);
		const doctor = steps[at("doctor")] as Step & { run?: string };
		expect(doctor.run).toContain("warden doctor --fetch-helper");
		// doctor reports ccache from PATH: before the install it warns about a ccache the action is about to add
		expect(at("ccache-prep")).toBeLessThan(at("doctor"));
		expect(at("doctor")).toBeLessThan(at("import"));
		expect(at("doctor")).toBeLessThan(at("golden-build"));
		expect(at("doctor")).toBeLessThan(at("run"));
	});

	test("the native build log is printed folded, its workflow commands disarmed; the compiler cache is saved", () => {
		const steps = action.runs.steps;
		const at = (id: string) => steps.findIndex((s) => s.id === id);
		const print = steps[at("build-log")] as Step & { run?: string };
		expect(at("build-log")).toBeGreaterThan(at("run"));
		expect(print.if).toContain("always()");
		expect(print.run).toContain("::group::");
		expect(print.run).toContain("::stop-commands::");
		expect(print.run).toContain("ccache --show-stats");
		const save = steps.find((s) => s.uses?.startsWith("actions/cache/save@") && s.with?.key?.includes("ccache"));
		expect(save?.if).toContain("always()");
		expect(save?.if).toContain("inputs.save-cache == 'true'");
		// saved under the restore step's per-run key, and only when the build stored objects
		expect(save?.with?.key).toBe(steps[at("ccache-cache")]?.with?.key);
		expect(save?.if).toContain("steps.build-log.outputs.ccache-writes != '0'");
		expect(save?.if).toContain("steps.build-log.outputs.ccache-writes != ''");
		expect(print.run).toContain('$1 == "local_storage_write"');
		expect(print.run).toContain("ccache-writes=");
	});

	test("the cache export reuses the golden the collection archived", () => {
		const steps = action.runs.steps;
		const exportIndex = steps.findIndex((s) => s.id === "golden-export");
		expect(steps.findIndex((s) => s.id === "artifacts")).toBeLessThan(exportIndex);
		expect(JSON.stringify(steps[exportIndex])).toContain("steps.artifacts.outputs.golden-archived");
	});
});
