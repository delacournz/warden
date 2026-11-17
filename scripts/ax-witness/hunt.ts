#!/usr/bin/env bun
/**
 * CI wedge hunt: per iteration, create a FRESH simulator (raw `simctl create` is fine here: the runner is a throwaway
 * VM, never a machine with leases), boot it, run `ax-witness.ts --observe` against it for a couple of minutes, delete
 * it. Iterations whose simd readers were silent for `--min-streak` reads in a row are flagged with what the runner
 * answered meanwhile. Writes `<out>/hunt.json` and a markdown table (also appended to `$GITHUB_STEP_SUMMARY`).
 *
 *   bun scripts/ax-witness/hunt.ts [--iterations 5] [--seconds 120] [--min-streak 3] [--out <dir>]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Summary, Verdict } from "./witness";

type Runtime = {
	identifier: string;
	version: string;
	isAvailable: boolean;
	platform?: string;
	name: string;
	/** Absent on older simctl; some images ship device-specific runtimes (`iOS-27-2-iPhone19-4`) next to the general one. */
	supportedDeviceTypes?: { identifier: string }[];
};
type DeviceType = { identifier: string; name: string; productFamily?: string };

function versionParts(version: string): number[] {
	return version.split(".").map((part) => Number(part) || 0);
}

function compareVersions(a: string, b: string): number {
	const [x, y] = [versionParts(a), versionParts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (x[i] ?? 0) - (y[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The newest available iOS runtime (that supports `deviceType`, when given), or undefined when none is installed. */
export function pickRuntime(runtimes: readonly Runtime[], deviceType?: string): Runtime | undefined {
	const supports = (r: Runtime): boolean =>
		deviceType === undefined ||
		r.supportedDeviceTypes === undefined ||
		r.supportedDeviceTypes.some((t) => t.identifier === deviceType);
	return runtimes
		.filter((r) => r.isAvailable && (r.platform === "iOS" || r.identifier.includes(".iOS-")) && supports(r))
		.sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** The highest-numbered plain `iPhone N` (no Pro / Air / SE / Plus / e variants); `list devicetypes` order is not by age. */
export function pickDeviceType(types: readonly DeviceType[]): DeviceType | undefined {
	const model = (t: DeviceType): number => Number(/^iPhone (\d+)$/.exec(t.name)?.[1] ?? 0);
	return [...types].sort((a, b) => model(b) - model(a))[0];
}

export type Iteration =
	| { index: number; status: "ok"; udid: string; verdict: Verdict; flagged: boolean; summary: Summary }
	| { index: number; status: "infra-failure"; reason: string };

/** Worth a look: simd went silent for a streak, or the runner never came up (on a wedged sim XCUITest may not start). */
export function iterationFlagged(summary: Summary): boolean {
	return summary.streaks.length > 0 || summary.runnerStartup.status === "failed";
}

export function markdownTable(iterations: readonly Iteration[]): string {
	const rows = iterations.map((it) => {
		if (it.status === "infra-failure") return `| ${it.index} | infra failure | - | - | ${it.reason} |`;
		const startup = it.summary.runnerStartup;
		const streaks = [
			...(startup.status === "failed" ? [`runner never ready: ${startup.reason}`] : []),
			...it.summary.streaks.map((s) => `${s.reads} reads / ${(s.durationMs / 1000).toFixed(0)} s: runner ${s.verdict}`),
		].join("; ");
		return `| ${it.index} | ${it.verdict}${it.flagged ? " (FLAGGED)" : ""} | ${it.summary.simd.silent}/${it.summary.simd.total} | ${it.summary.runner.answered}/${it.summary.runner.total} | ${streaks || "-"} |`;
	});
	return ["| # | verdict | simd silent | runner answered | silent streaks |", "|---|---|---|---|---|", ...rows].join(
		"\n"
	);
}

export type HarnessArgsInput = {
	script: string;
	udid: string;
	seconds: number;
	minStreak: number;
	dir: string;
	/** An earlier iteration came back ok, so the runner build in the shared derived data is usable. */
	built: boolean;
};

/** `ax-witness.ts --observe` args for one iteration; `--skip-build` only once a build is known to have succeeded. */
export function harnessArgs(input: HarnessArgsInput): string[] {
	return [
		input.script,
		"--udid",
		input.udid,
		"--observe",
		"--seconds",
		String(input.seconds),
		"--min-streak",
		String(input.minStreak),
		"--out",
		input.dir,
		...(input.built ? ["--skip-build"] : []),
	];
}

function simctlJson<T>(args: string[], key: string): T[] {
	const run = spawnSync("xcrun", ["simctl", ...args, "-j"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	return (JSON.parse(run.stdout) as Record<string, T[]>)[key] ?? [];
}

function sh(args: string[]): { ok: boolean; out: string } {
	const run = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
	return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() };
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function createBootedSim(index: number): { udid: string } | { reason: string } {
	const type = pickDeviceType(simctlJson<DeviceType>(["list", "devicetypes"], "devicetypes"));
	const runtime = pickRuntime(simctlJson<Runtime>(["list", "runtimes"], "runtimes"), type?.identifier);
	if (!runtime || !type) return { reason: "no iOS runtime or iPhone device type on this runner" };
	const created = sh(["create", `ax-hunt-${index}`, type.identifier, runtime.identifier]);
	if (!created.ok) return { reason: `simctl create: ${created.out.slice(0, 200)}` };
	const udid = created.out.split("\n").pop() ?? "";
	const booted = sh(["bootstatus", udid, "-b"]);
	if (!booted.ok) {
		sh(["delete", udid]);
		return { reason: `simctl bootstatus: ${booted.out.slice(0, 200)}` };
	}
	return { udid };
}

function runIteration(index: number, out: string, seconds: number, minStreak: number, built: boolean): Iteration {
	const sim = createBootedSim(index);
	if ("reason" in sim) return { index, status: "infra-failure", reason: sim.reason };
	const dir = join(out, `iteration-${index}`);
	mkdirSync(dir, { recursive: true });
	try {
		const harness = spawnSync(
			"bun",
			harnessArgs({ script: join(import.meta.dir, "ax-witness.ts"), udid: sim.udid, seconds, minStreak, dir, built }),
			{ encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] }
		);
		const summaryPath = join(dir, "summary.json");
		if (harness.status !== 0 || !existsSync(summaryPath)) {
			return { index, status: "infra-failure", reason: `ax-witness exited ${harness.status}` };
		}
		const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Summary;
		return {
			index,
			status: "ok",
			udid: sim.udid,
			verdict: summary.verdict,
			flagged: iterationFlagged(summary),
			summary,
		};
	} finally {
		sh(["shutdown", sim.udid]);
		sh(["delete", sim.udid]);
	}
}

function main(): number {
	const iterations = Number(arg("iterations", "5"));
	const seconds = Number(arg("seconds", "120"));
	const minStreak = Number(arg("min-streak", "3"));
	const out = resolve(arg("out", "ax-witness-out"));
	mkdirSync(out, { recursive: true });
	const results: Iteration[] = [];
	for (let index = 1; index <= iterations; index++) {
		console.log(`::group::iteration ${index}/${iterations}`);
		const built = results.some((r) => r.status === "ok");
		results.push(runIteration(index, out, seconds, minStreak, built));
		console.log("::endgroup::");
	}
	const table = markdownTable(results);
	const flagged = results.filter((r) => r.status === "ok" && r.flagged).length;
	writeFileSync(join(out, "hunt.json"), `${JSON.stringify({ iterations: results, flagged }, null, 2)}\n`);
	writeFileSync(join(out, "hunt.md"), `${table}\n`);
	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		appendFileSync(stepSummary, `## AX wedge hunt\n\n${flagged} of ${iterations} iterations flagged.\n\n${table}\n`);
	}
	console.log(`\n${table}\n\nflagged: ${flagged}/${iterations}`);
	return results.some((r) => r.status === "ok") ? 0 : 1;
}

if (import.meta.main) process.exit(main());
