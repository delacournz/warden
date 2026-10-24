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
	| { command: "compare"; dirA: string; dirB: string }
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
  bench compare <A> <B>     markdown diff of two run dirs
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
};

const intOf = (flag: string, value: string, min: number): number | string => {
	const n = Number(value);
	return Number.isInteger(n) && n >= min ? n : `${flag} must be an integer >= ${min}, got ${value}`;
};

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
const RUN_FLAGS = Object.keys(VALUE_SETTERS)
	.concat(Object.keys(BOOL_SETTERS))
	.filter((flag) => flag !== "--eas");
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
			return (
				expectPositionals("compare", positionals, 2, "<dirA> <dirB>") ?? {
					command: "compare",
					dirA: positionals[0] ?? "",
					dirB: positionals[1] ?? "",
				}
			);
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

/** Parses `bench <command> …`; a string back is the complaint (print it with the help). */
export function parseArgs(argv: readonly string[]): Command | string {
	const [name, ...rest] = argv;
	if (name === undefined || name === "help" || name === "--help" || name === "-h") return { command: "help" };
	if (name === "app") return parseApp(rest);
	const parsed = parseFlags(
		rest,
		name === "run" ? RUN_FLAGS : name === "doctor" ? ["--platform"] : name === "summary" ? SUMMARY_FLAGS : []
	);
	return typeof parsed === "string" ? parsed : build(name, parsed.flags, parsed.positionals);
}
