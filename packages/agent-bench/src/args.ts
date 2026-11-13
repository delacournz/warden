import { err, ok, type Result } from "@delacour/warden-types/result";
import { isToolId, TOOL_IDS, type ToolId } from "./kit";

export type Args =
	| { kind: "help" }
	| { kind: "list" }
	| { kind: "run"; suite: string; model?: string; udid?: string; out?: string; tools?: ToolId[]; json: boolean };

export const HELP = `bun run bench:agent <suite> [options]   run one agent suite with every tool (${TOOL_IDS.join(", ")}), then compare
bun run bench:agent list                list the committed suites

  --tools <a,b>    only these tools (${TOOL_IDS.join(", ")}); default: the suite's (all)
  --model <id>     override the suite's model
  --udid <id>      use a device you already leased (needs WARDEN_SESSION_ID of that lease); nothing is claimed or released
  --out <dir>      write the run here instead of <repo>/.bench/<run-id>
  --json           print report.json instead of the markdown table

Needs CLAUDE_CODE_OAUTH_TOKEN (\`claude setup-token\`) or ANTHROPIC_API_KEY, and the pinned bench app
(\`bun run bench app build --platform ios\`). argent and agent-device run when they are on PATH; a missing one is
reported as unavailable.`;

const VALUED = { "--model": "model", "--udid": "udid", "--out": "out" } as const;

/** `warden,argent` → tool ids (deduplicated); an unknown name is an error. */
export function parseTools(value: string): Result<ToolId[]> {
	const names = value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (names.length === 0) return err("--tools needs at least one tool");
	const bad = names.filter((n) => !isToolId(n));
	if (bad.length > 0) return err(`unknown tool ${bad.join(", ")} (expected ${TOOL_IDS.join(", ")})`);
	return ok([...new Set(names.filter(isToolId))]);
}

function isValued(flag: string): flag is keyof typeof VALUED {
	return flag in VALUED;
}

type RunArgs = Extract<Args, { kind: "run" }>;

/** Folds one argument (and a flag's value) into `acc`; returns how many arguments it used. */
function take(argv: readonly string[], i: number, acc: Partial<RunArgs>): Result<number> {
	const arg = argv[i] ?? "";
	if (arg === "--json") {
		acc.json = true;
		return ok(1);
	}
	if (arg === "--tools") {
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return err("--tools needs a value");
		const tools = parseTools(value);
		if (!tools.success) return tools;
		acc.tools = tools.data;
		return ok(2);
	}
	if (isValued(arg)) {
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return err(`${arg} needs a value`);
		acc[VALUED[arg]] = value;
		return ok(2);
	}
	if (arg.startsWith("-")) return err(`unknown option ${arg}`);
	if (acc.suite !== undefined) return err(`unexpected argument ${arg}`);
	acc.suite = arg;
	return ok(1);
}

export function parseArgs(argv: readonly string[]): Result<Args> {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return ok({ kind: "help" });
	if (argv[0] === "list" && argv.length === 1) return ok({ kind: "list" });
	const acc: Partial<RunArgs> = {};
	for (let i = 0; i < argv.length; ) {
		const used = take(argv, i, acc);
		if (!used.success) return used;
		i += used.data;
	}
	const { suite, json, ...values } = acc;
	if (suite === undefined) return err("missing <suite>");
	return ok({ kind: "run", suite, ...values, json: json === true });
}
