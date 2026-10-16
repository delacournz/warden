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
};

export type Command =
	| RunCommand
	| { command: "doctor"; platform: Platform }
	| { command: "list" }
	| { command: "report"; runDir: string }
	| { command: "compare"; dirA: string; dirB: string }
	| { command: "summary"; runDir: string; out?: string }
	| { command: "help" };

export const HELP = `bench: benchmark six mobile e2e frameworks on the example app's parity suite

Usage:
  bench run [options]       run the suite per framework and write .bench/<run-id>/
  bench doctor [--platform] check every framework is installed and usable
  bench list                frameworks, platforms and the 8 canonical test ids
  bench report <runDir>     re-render report.md / report.html from bench-results.json
  bench compare <A> <B>     markdown diff of two run dirs
  bench summary <runDir> [--out file]  slim summary.json for the docs comparison page

Run options:
  --platform ios|android    default ios
  --frameworks a,b          default all (warden,maestro,argent,agent-device,tester-army,detox)
  --runs N                  reps per framework, rep 1 is cold (default 3)
  --retries N               forwarded to every framework (default 0)
  --udid X                  use a device you already leased (no claim, no release)
  --reboot-between          reboot the device between frameworks
  --out DIR                 output dir (default .bench/<timestamp>-<platform>)
  --skip-doctor             do not run doctor before each framework
  --force                   run even when the host load average exceeds the core count
  --keep-drivers            keep driver apps installed (skip the cold uninstall)
  --node-bin PATH           node binary to put first on PATH for the frameworks
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
};

const SUMMARY_FLAGS = ["--out"];
const RUN_FLAGS = [...Object.keys(VALUE_SETTERS), ...Object.keys(BOOL_SETTERS)];

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
	};
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
	const parsed = parseFlags(
		rest,
		name === "run" ? RUN_FLAGS : name === "doctor" ? ["--platform"] : name === "summary" ? SUMMARY_FLAGS : []
	);
	return typeof parsed === "string" ? parsed : build(name, parsed.flags, parsed.positionals);
}
