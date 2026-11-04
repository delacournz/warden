import { err, ok, type Result } from "@delacour/warden-types/result";
import { shellSplit } from "./ssh";

/**
 * What a laptop may run on a host through its forced command (`__host-serve`). The command line arrives in
 * `SSH_ORIGINAL_COMMAND`; it is split here and run as an argv (never through a shell). Each entry names the
 * flags it refuses: `--session` / `--all` / `--udid` / `port --force` would reach leases that are not the caller's,
 * `doctor --fix` writes.
 */
/** every `warden perf` subcommand: each acts on the device of `--lease`, which `__host-serve` holds to the caller's own */
const PERF_SUBCOMMANDS = [
	"start",
	"stop",
	"record",
	"mark",
	"report",
	"query",
	"diff",
	"metrics",
	"memory",
	"frames",
	"startup",
	"js",
	"heap",
	"react",
	"native",
	"logs",
	"crashes",
	"ls",
	"doctor",
	"tools",
] as const;

type Rule = { json: boolean; refuse: readonly string[]; subcommands?: readonly string[] };

const ALLOWED = {
	version: { json: true, refuse: [] },
	claim: { json: true, refuse: ["--session"] },
	heartbeat: { json: true, refuse: ["--session", "--all", "--udid"] },
	release: { json: true, refuse: ["--session", "--all", "--udid"] },
	ls: { json: true, refuse: [] },
	doctor: { json: true, refuse: ["--fix", "--fetch-helper"] },
	port: { json: true, refuse: ["--force"] },
	"__driver-serve": { json: false, refuse: [] },
	"__host-recv": { json: true, refuse: [] },
	"__host-tunnel": { json: true, refuse: [] },
	// passthrough (`warden host run`): text or --json, a device only through the caller's own --lease
	perf: {
		json: false,
		refuse: ["--udid", "--serial", "--claim", "--force", "--allow-mutate-foreign"],
		subcommands: PERF_SUBCOMMANDS,
	},
	golden: { json: false, refuse: [], subcommands: ["ls", "ensure"] },
	builds: { json: false, refuse: [], subcommands: ["ls"] },
	capacity: { json: false, refuse: [] },
	queue: { json: false, refuse: [] },
	"__host-send": { json: false, refuse: [] },
} as const satisfies Record<string, Rule>;

export type HostCommandName = keyof typeof ALLOWED;

export const HOST_COMMANDS: readonly HostCommandName[] = Object.keys(ALLOWED) as HostCommandName[];

export type HostCommand = { name: HostCommandName; argv: string[] };

const SHELL_META = /[;&|`$<>\n\r\\]/;

function isAllowed(name: string): name is HostCommandName {
	return Object.hasOwn(ALLOWED, name);
}

/** The warden argv a forced-command line may run, or why not. A leading `warden` (or a path to it) is dropped. */
export function checkHostCommand(line: string): Result<HostCommand> {
	const split = shellSplit(line);
	if (!split.success) return err(`refused: ${split.error}`);
	const words = [...split.data];
	if (words[0] === "warden" || words[0]?.endsWith("/warden")) words.shift();
	const name = words[0];
	const allowedList = `allowed: ${HOST_COMMANDS.join(", ")}`;
	if (name === undefined) return err(`refused: no command (${allowedList})`);
	if (!isAllowed(name)) return err(`refused: \`${name}\` is not allowed over warden host (${allowedList})`);
	const rule: Rule = ALLOWED[name];
	const sub = words[1];
	if (rule.subcommands !== undefined && (sub === undefined || !rule.subcommands.includes(sub))) {
		return err(
			`refused: \`${name} ${sub ?? ""}\` is not allowed over warden host (allowed: ${rule.subcommands.map((s) => `${name} ${s}`).join(", ")})`
		);
	}
	const bad = words.find((w) => SHELL_META.test(w));
	if (bad !== undefined) return err(`refused: \`${bad}\` holds a shell character`);
	for (const flag of rule.refuse) {
		if (words.some((w) => w === flag || w.startsWith(`${flag}=`))) {
			return err(`refused: \`${name} ${flag}\` is not allowed over warden host`);
		}
	}
	if (rule.json && !words.includes("--json"))
		return err(`refused: \`${name}\` must be run with --json over warden host`);
	return ok({ name, argv: words });
}
