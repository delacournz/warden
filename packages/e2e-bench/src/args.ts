import { FRAMEWORK_IDS, type FrameworkId, isFrameworkId } from "./adapters/adapter.types";
import type { Platform } from "./results/schema";

export type RunCommand = {
	command: "run";
	platform: Platform;
	frameworks: FrameworkId[];
	runs: number;
	retries: number;
	udid?: string;
	rebootBetween: boolean;
	out?: string;
	skipDoctor: boolean;
	force: boolean;
	keepDrivers: boolean;
	nodeBin?: string;
	/** a pinned bench app dir (with `manifest.json`) or a bare `.app` / `.apk` to pin */
	app?: string;
};

export type Command =
	| RunCommand
	| { command: "app-build"; platform: Platform; force: boolean; eas: boolean }
	| { command: "app-status"; platform: Platform }
	| { command: "app-clean"; platform: Platform }
	| { command: "doctor"; platform: Platform }
	| { command: "list" }
	| { command: "report"; runDir: string }
	| { command: "compare"; dirA: string; dirB: string; maxCpuRegressionPct?: number }
	| { command: "merge"; outDir: string; runDirs: string[]; id?: string }
	| { command: "summary"; runDir: string; out?: string }
	| { command: "help" };

export const HELP = `bench: benchmark six mobile e2e frameworks on the example app's parity suite

Usage:
  bench run [options]       run the suite per framework and write .bench/<run-id>/
  bench app build|status|clean [--platform ios|android] [--force] [--eas]
                            pin, inspect or remove the bench app (.bench/app/<platform>)
  bench doctor [--platform] check every framework is installed and usable
  bench list                frameworks, platforms and the 8 canonical test ids
  bench report <runDir>     re-render report.md / report.html from bench-results.json
  bench compare <A> <B> [--max-cpu-regression PCT]
                            markdown diff of two run dirs. With --max-cpu-regression (10% or 10) it then exits 1
                            when warden's host CPU-seconds per rep or host RSS peak in B exceed A's by more than
                            PCT, and 2 when warden is missing from a side. A may instead be a baseline file
                            (packages/e2e-bench/baselines/ios-warden.json, which requires the flag): the guard
                            runs on its numbers alone, with no markdown diff
  bench merge <outDir> <runDir>... [--id ID]
                            merge per-framework run dirs (one EAS worker each) into <outDir> with every
                            framework, ratios recomputed, inputs copied to <outDir>/workers/<framework>/;
                            exit 2 on a repeated framework or a different platform / app sha
  bench summary <runDir> [--out file]  slim summary.json for the docs comparison page

Run options:
  --platform ios|android    default ios
  --frameworks a,b          default all (warden,argent,agent-device,tester-army)
  --runs N                  reps per framework, rep 1 is cold (default 3)
  --retries N               forwarded to every framework (default 0)
  --udid X                  use a device you already leased (no claim, release or heartbeat: hold it yourself)
  --reboot-between          reboot the device between frameworks
  --out DIR                 output dir (default .bench/<timestamp>-<platform>)
  --skip-doctor             do not run doctor before each framework
  --force                   run even when the host load average exceeds the core count
  --keep-drivers            keep driver apps installed (skip the cold uninstall)
  --node-bin PATH           node binary to put first on PATH for the frameworks
  --app PATH                bench app dir (has manifest.json) or a bare .app/.apk to pin (default: .bench/app/<platform>, built once when missing)

App options:
  app build                 build (or fetch) apps/example once and pin it; no-op when already pinned
  app status                pinned hash vs the project's current fingerprint; exit 1 when missing or stale
  app clean                 remove the pinned app
  --force                   (app build) rebuild even when pinned
  --eas                     (app build) allow warden to fetch an EAS build instead of building locally
`;

type Flags = {
	platform?: Platform;
	frameworks?: FrameworkId[];
	runs?: number;
	retries?: number;
	udid?: string;
	out?: string;
	nodeBin?: string;
	rebootBetween?: boolean;
	skipDoctor?: boolean;
	force?: boolean;
	keepDrivers?: boolean;
	eas?: boolean;
	app?: string;
	maxCpuRegressionPct?: number;
	id?: string;
};

const intOf = (flag: string, value: string, min: number): number | string => {
	const n = Number(value);
	return Number.isInteger(n) && n >= min ? n : `${flag} must be an integer >= ${min}, got ${value}`;
};

/** `10%`, `10` or `7.5%` as a non-negative number of percent; undefined for anything else. */
export function percentOf(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)%?$/.exec(value);
	return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

/** Value flags: each stores into `flags`; a string back is the complaint. */
const VALUE_SETTERS: Record<string, (flags: Flags, value: string) => string | undefined> = {
	"--platform": (flags, value) => {
		if (value !== "ios" && value !== "android") return `--platform must be ios or android, got ${value}`;
		flags.platform = value;
		return undefined;
	},
	"--frameworks": (flags, value) => {
		const names = value.split(",").filter((n) => n !== "");
		const bad = names.filter((n) => !isFrameworkId(n));
		if (bad.length > 0 || names.length === 0)
			return `--frameworks: unknown ${bad.join(",") || "(empty)"}; known: ${FRAMEWORK_IDS.join(",")}`;
		flags.frameworks = FRAMEWORK_IDS.filter((id) => names.includes(id));
		return undefined;
	},
	"--runs": (flags, value) => {
		const n = intOf("--runs", value, 1);
		if (typeof n === "string") return n;
		flags.runs = n;
		return undefined;
	},
	"--retries": (flags, value) => {
		const n = intOf("--retries", value, 0);
		if (typeof n === "string") return n;
		flags.retries = n;
		return undefined;
	},
	"--udid": (flags, value) => {
		flags.udid = value;
		return undefined;
	},
	"--out": (flags, value) => {
		flags.out = value;
		return undefined;
	},
	"--node-bin": (flags, value) => {
		flags.nodeBin = value;
		return undefined;
	},
	"--app": (flags, value) => {
		flags.app = value;
		return undefined;
	},
	"--max-cpu-regression": (flags, value) => {
		const n = percentOf(value);
		if (n === undefined) return `--max-cpu-regression must be a percent like 10% or 10, got ${value}`;
		flags.maxCpuRegressionPct = n;
		return undefined;
	},
	"--id": (flags, value) => {
		flags.id = value;
		return undefined;
	},
};

/** Boolean flags take no value. */
const BOOL_SETTERS: Record<string, (flags: Flags) => void> = {
	"--reboot-between": (flags) => {
		flags.rebootBetween = true;
	},
	"--skip-doctor": (flags) => {
		flags.skipDoctor = true;
	},
	"--force": (flags) => {
		flags.force = true;
	},
	"--keep-drivers": (flags) => {
		flags.keepDrivers = true;
	},
	"--eas": (flags) => {
		flags.eas = true;
	},
};

const SUMMARY_FLAGS = ["--out"];
const COMPARE_FLAGS = ["--max-cpu-regression"];
const MERGE_FLAGS = ["--id"];
const RUN_FLAGS = Object.keys(VALUE_SETTERS)
	.concat(Object.keys(BOOL_SETTERS))
	.filter((flag) => flag !== "--eas" && !COMPARE_FLAGS.includes(flag) && !MERGE_FLAGS.includes(flag));
const APP_SUBCOMMANDS = ["build", "status", "clean"] as const;
type AppSubcommand = (typeof APP_SUBCOMMANDS)[number];
const APP_FLAGS: Record<AppSubcommand, readonly string[]> = {
	build: ["--platform", "--force", "--eas"],
	status: ["--platform"],
	clean: ["--platform"],
};
const isAppSubcommand = (name: string | undefined): name is AppSubcommand =>
	APP_SUBCOMMANDS.some((sub) => sub === name);

type Parsed = { flags: Flags; positionals: string[] };

/** Splits argv into flags (limited to `allowed`) and positionals; a string back is the complaint. */
function parseFlags(argv: readonly string[], allowed: readonly string[]): Parsed | string {
	const flags: Flags = {};
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		if (!allowed.includes(arg)) return `unknown argument ${arg}`;
		const bool = BOOL_SETTERS[arg];
		if (bool !== undefined) {
			bool(flags);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
		i++;
		const complaint = VALUE_SETTERS[arg]?.(flags, value);
		if (complaint !== undefined) return complaint;
	}
	return { flags, positionals };
}

function runCommand(flags: Flags): RunCommand {
	return {
		command: "run",
		platform: flags.platform ?? "ios",
		frameworks: flags.frameworks ?? [...FRAMEWORK_IDS],
		runs: flags.runs ?? 3,
		retries: flags.retries ?? 0,
		rebootBetween: flags.rebootBetween ?? false,
		skipDoctor: flags.skipDoctor ?? false,
		force: flags.force ?? false,
		keepDrivers: flags.keepDrivers ?? false,
		...(flags.udid !== undefined ? { udid: flags.udid } : {}),
		...(flags.out !== undefined ? { out: flags.out } : {}),
		...(flags.nodeBin !== undefined ? { nodeBin: flags.nodeBin } : {}),
		...(flags.app !== undefined ? { app: flags.app } : {}),
	};
}

/** `bench app <sub> …`: the subcommand picks the allowed flags. */
function parseApp(rest: readonly string[]): Command | string {
	const [sub, ...flagArgs] = rest;
	if (!isAppSubcommand(sub)) return `app needs a subcommand: ${APP_SUBCOMMANDS.join("|")}`;
	const parsed = parseFlags(flagArgs, APP_FLAGS[sub]);
	if (typeof parsed === "string") return parsed;
	const complaint = NO_POSITIONALS(`app ${sub}`, parsed.positionals);
	if (complaint !== undefined) return complaint;
	const platform = parsed.flags.platform ?? "ios";
	if (sub === "build")
		return { command: "app-build", platform, force: parsed.flags.force ?? false, eas: parsed.flags.eas ?? false };
	return sub === "status" ? { command: "app-status", platform } : { command: "app-clean", platform };
}

/** `positionals` must be exactly `count` long. */
function expectPositionals(
	name: string,
	positionals: readonly string[],
	count: number,
	usage: string
): string | undefined {
	return positionals.length === count ? undefined : `${name} needs ${usage}`;
}

const NO_POSITIONALS = (name: string, positionals: readonly string[]): string | undefined =>
	positionals.length > 0 ? `${name} takes no positional arguments, got ${positionals[0]}` : undefined;

function buildCompare(flags: Flags, positionals: readonly string[]): Command | string {
	return (
		expectPositionals("compare", positionals, 2, "<dirA> <dirB>") ?? {
			command: "compare",
			dirA: positionals[0] ?? "",
			dirB: positionals[1] ?? "",
			...(flags.maxCpuRegressionPct !== undefined ? { maxCpuRegressionPct: flags.maxCpuRegressionPct } : {}),
		}
	);
}

function buildMerge(flags: Flags, positionals: readonly string[]): Command | string {
	if (positionals.length < 2) return "merge needs <outDir> <runDir>...";
	return {
		command: "merge",
		outDir: positionals[0] ?? "",
		runDirs: positionals.slice(1),
		...(flags.id !== undefined ? { id: flags.id } : {}),
	};
}

/** Builds the command once the flags parsed; a string back is the complaint. */
function build(name: string, flags: Flags, positionals: readonly string[]): Command | string {
	switch (name) {
		case "run":
			return NO_POSITIONALS(name, positionals) ?? runCommand(flags);
		case "doctor":
			return NO_POSITIONALS(name, positionals) ?? { command: "doctor", platform: flags.platform ?? "ios" };
		case "list":
			return NO_POSITIONALS(name, positionals) ?? { command: "list" };
		case "report":
			return (
				expectPositionals("report", positionals, 1, "<runDir>") ?? { command: "report", runDir: positionals[0] ?? "" }
			);
		case "compare":
			return buildCompare(flags, positionals);
		case "merge":
			return buildMerge(flags, positionals);
		case "summary":
			return (
				expectPositionals("summary", positionals, 1, "<runDir>") ?? {
					command: "summary",
					runDir: positionals[0] ?? "",
					...(flags.out !== undefined ? { out: flags.out } : {}),
				}
			);
		default:
			return `unknown command ${name}`;
	}
}

/** The flags a command accepts (positional-only commands accept none). */
function allowedFlags(name: string): readonly string[] {
	const byCommand: Record<string, readonly string[]> = {
		run: RUN_FLAGS,
		doctor: ["--platform"],
		summary: SUMMARY_FLAGS,
		compare: COMPARE_FLAGS,
		merge: MERGE_FLAGS,
	};
	return byCommand[name] ?? [];
}

/** Parses `bench <command> …`; a string back is the complaint (print it with the help). */
export function parseArgs(argv: readonly string[]): Command | string {
	const [name, ...rest] = argv;
	if (name === undefined || name === "help" || name === "--help" || name === "-h") return { command: "help" };
	if (name === "app") return parseApp(rest);
	const parsed = parseFlags(rest, allowedFlags(name));
	return typeof parsed === "string" ? parsed : build(name, parsed.flags, parsed.positionals);
}
