import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BenchAdapter } from "@delacour/warden-e2e-bench/src/adapters/adapter.types";
import { agentDeviceAdapter, stateDirOf } from "@delacour/warden-e2e-bench/src/adapters/agent-device";
import { argentAdapter } from "@delacour/warden-e2e-bench/src/adapters/argent";
import { wardenAdapter } from "@delacour/warden-e2e-bench/src/adapters/warden";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";

/** The tools a suite runs, in this order (same order as `packages/e2e-bench`). */
export const TOOL_IDS = ["warden", "argent", "agent-device"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export const toolIdSchema = z.enum(TOOL_IDS);

export function isToolId(value: string): value is ToolId {
	return (TOOL_IDS as readonly string[]).includes(value);
}

/**
 * How the stream parser recognises a call to the tool under test. `cli`: a Bash command running `bin`
 * (`groups` are subcommands whose next word is the verb, e.g. `warden ui press` → `ui press`). `mcp`: a
 * `tool_use` named `mcp__<server>__<tool>` (verb = `<tool>`).
 */
export type Driver = { kind: "cli"; bin: string; groups: readonly string[] } | { kind: "mcp"; server: string };

/** A file or directory copied into the agent's `CLAUDE_CONFIG_DIR` (`to` is relative to it). */
export type KitFile = { from: string; to: string; exclude?: readonly string[] };

/** An executable written into the sandbox's `bin/` (first on PATH): `exec <argv…> "$@"`. */
export type Shim = { name: string; argv: readonly string[] };

export type McpServer = { command: string; args: readonly string[] };

/** Everything one tool needs inside the bench: what the agent gets, and how its calls are counted. */
export type Kit = {
	tool: ToolId;
	/** the installed version (CLI package.json, or this checkout's for warden) */
	version: string;
	/** the agent's skills and always-on rules, as the tool's own Claude Code setup installs them */
	files: KitFile[];
	shims: Shim[];
	mcpServers: Record<string, McpServer>;
	/** added to the agent's env (and to the e2e-bench adapter's, so prepare and teardown see the same state) */
	env: Record<string, string>;
	/** passed to `claude --allowedTools`; everything else is denied */
	allowedTools: string[];
	/** the tool's error codes, counted in tool results (with the suite's own) */
	failurePatterns: string[];
	driver: Driver;
	/**
	 * a CLI kit's Bash gate (`PreToolUse` hook argv): `Bash(<bin> *)` alone denies `U=<udid>; <bin> …`, so the
	 * gate decides every Bash call (see `bash-gate.ts`); absent for an MCP kit, which has no Bash
	 */
	bashGate?: readonly string[];
	/** prepended to the suite's task; `{{udid}}`, `{{platform}}`, `{{bundleId}}`, `{{deviceFlag}}` filled in */
	preamble: string;
	/** the e2e-bench adapter whose doctor / prepare / teardown / residue patterns the bench reuses */
	adapter: BenchAdapter;
	/** caveats printed in the report (a skill version that differs from the CLI, …) */
	notes: string[];
};

export type KitDeps = {
	/** absolute path of a command on PATH */
	which: (cmd: string) => string | undefined;
	/** the npm package root a bin belongs to (realpath, then up to the nearest package.json) */
	packageRootOf: (bin: string) => string | undefined;
	readText: (path: string) => string | undefined;
	exists: (path: string) => boolean;
	env: Record<string, string | undefined>;
	home: () => string;
};

const readTextIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

/** Walks up from the bin's real path to the first directory holding a package.json. */
export function defaultPackageRootOf(bin: string): string | undefined {
	let dir: string;
	try {
		dir = dirname(realpathSync(bin));
	} catch {
		return undefined;
	}
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function defaultKitDeps(which: KitDeps["which"], env: KitDeps["env"]): KitDeps {
	return {
		which,
		packageRootOf: defaultPackageRootOf,
		readText: readTextIfPresent,
		exists: existsSync,
		env,
		home: homedir,
	};
}

function parseJson(raw: string | undefined): unknown {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function versionAt(deps: KitDeps, packageJson: string): string {
	const parsed = z.object({ version: z.string() }).safeParse(parseJson(deps.readText(packageJson)));
	return parsed.success ? parsed.data.version : "unknown";
}

/** Where the bench's kits live: `packages/agent-bench/kits/<tool>`. */
export const KITS_DIR = resolve(import.meta.dir, "..", "kits");

/** `bash-gate.ts`, run by bun as the sandbox's `PreToolUse` hook. */
export const BASH_GATE = resolve(import.meta.dir, "bash-gate.ts");

const bashGate = (bunPath: string, bin: string): string[] => [bunPath, BASH_GATE, bin];

const WARDEN_FAILURES = [
	"stale_ref",
	"E_TIMEOUT",
	"target_not_found",
	"wait_target_absent",
	"wait_text_absent",
	"device_not_leased",
	"device_foreign",
	"ambiguous_device",
	"usage",
];

const AGENT_DEVICE_FAILURES = [
	"INVALID_ARGS",
	"COMMAND_FAILED",
	"AMBIGUOUS_MATCH",
	"ELEMENT_NOT_FOUND",
	"ELEMENT_OFFSCREEN",
	"TEXT_ENTRY_MISMATCH",
	"UNSUPPORTED_OPERATION",
	"RUNNER_BUSY",
	"RUNNER_WEDGED",
];

const LEASED =
	"The app {{bundleId}} is installed on the {{platform}} device {{udid}}, which is already leased for you.";
const BOOTED =
	"The app {{bundleId}} is installed on the {{platform}} device {{udid}}, which is already booted for you.";

export type KitInput = { repoRoot: string; bunPath: string; cliPath: string };

function wardenKit(input: KitInput, deps: KitDeps): Result<Kit> {
	const skillDir = join(input.repoRoot, "skills", "warden");
	if (!deps.exists(join(skillDir, "SKILL.md"))) return err(`warden skill not found at ${skillDir}`);
	return ok({
		tool: "warden",
		version: versionAt(deps, join(input.repoRoot, "apps", "cli", "package.json")),
		files: [
			{ from: skillDir, to: "skills/warden", exclude: ["rules"] },
			{ from: join(skillDir, "rules", "warden.md"), to: "rules/warden.md" },
		],
		shims: [{ name: "warden", argv: [input.bunPath, input.cliPath] }],
		mcpServers: {},
		env: {},
		allowedTools: ["Bash(warden *)", "Skill", "Read"],
		failurePatterns: WARDEN_FAILURES,
		driver: { kind: "cli", bin: "warden", groups: ["ui"] },
		bashGate: bashGate(input.bunPath, "warden"),
		preamble: `${LEASED} Drive it only with the \`warden\` CLI and always pass \`--udid {{udid}}\`. Do not claim, release or boot any other device, and do not run \`warden ui close --release\`: the harness releases the lease when you finish.`,
		adapter: wardenAdapter,
		notes: ["CLI and skill from this checkout"],
	});
}

/**
 * What `argent init` installs for Claude Code, minus the `argent-environment-inspector` subagent (the bench is
 * one agent, and its empty work dir has no project to inspect): `rules/argent.md`, every `skills/argent-*`, and
 * the `argent` MCP server (`argent mcp`), allowed as `mcp__argent`.
 */
function argentKit(deps: KitDeps): Result<Kit> {
	const bin = deps.which("argent");
	if (bin === undefined) return err("argent is not on PATH (bun add -g @swmansion/argent)");
	const root = deps.packageRootOf(bin);
	if (root === undefined) return err(`argent package root not found from ${bin}`);
	const rule = join(root, "rules", "argent.md");
	if (!deps.exists(rule)) return err(`argent rule not found at ${rule}`);
	return ok({
		tool: "argent",
		version: versionAt(deps, join(root, "package.json")),
		files: [
			{ from: join(root, "skills"), to: "skills" },
			{ from: rule, to: "rules/argent.md" },
		],
		shims: [],
		mcpServers: { argent: { command: bin, args: ["mcp"] } },
		env: {},
		allowedTools: ["mcp__argent", "Skill", "Read"],
		failurePatterns: [],
		driver: { kind: "mcp", server: "argent" },
		preamble: `${BOOTED} Drive it only with the argent MCP tools, on that device only (id \`{{udid}}\`). Do not boot, shut down or touch any other device: the harness cleans up when you finish.`,
		adapter: argentAdapter,
		notes: ["skills, rule and MCP server from the installed package; no subagents"],
	});
}

const vendoredSchema = z.object({ repo: z.string(), tag: z.string(), commit: z.string() });

/**
 * agent-device's skills ship from its GitHub repo, not npm (`npx skills add callstack/agent-device`), so the bench
 * vendors them at the release tag in `kits/agent-device/` (with its recommended agent rule). The agent drives
 * the CLI, as the skill teaches, under the e2e-bench's private `AGENT_DEVICE_STATE_DIR`.
 */
function agentDeviceKit(input: KitInput, deps: KitDeps): Result<Kit> {
	const bin = deps.which("agent-device");
	if (bin === undefined) return err("agent-device is not on PATH (bun add -g agent-device)");
	const root = deps.packageRootOf(bin);
	const version = root === undefined ? "unknown" : versionAt(deps, join(root, "package.json"));
	const kitDir = join(KITS_DIR, "agent-device");
	const source = vendoredSchema.safeParse(parseJson(deps.readText(join(kitDir, "SOURCE.json"))));
	const notes = ["skills vendored from the GitHub repo; CLI from PATH"];
	if (source.success && source.data.tag !== `v${version}`)
		notes.push(`skills are from ${source.data.tag}, the CLI is ${version}: refresh kits/agent-device`);
	return ok({
		tool: "agent-device",
		version,
		files: [
			{ from: join(kitDir, "skills"), to: "skills" },
			{ from: join(kitDir, "rules", "agent-device.md"), to: "rules/agent-device.md" },
		],
		shims: [],
		mcpServers: {},
		env: { AGENT_DEVICE_STATE_DIR: stateDirOf(deps.env, deps.home()) },
		allowedTools: ["Bash(agent-device *)", "Skill", "Read"],
		failurePatterns: AGENT_DEVICE_FAILURES,
		driver: { kind: "cli", bin: "agent-device", groups: [] },
		bashGate: bashGate(input.bunPath, "agent-device"),
		preamble: `${BOOTED} Drive it only with the \`agent-device\` CLI and always pass \`{{deviceFlag}} {{udid}}\`. Do not boot or shut down any device (no \`close --shutdown\`): the harness cleans up when you finish.`,
		adapter: agentDeviceAdapter,
		notes,
	});
}

/** The kit for one tool, or why it cannot run here (not installed, files missing). */
export function resolveKit(tool: ToolId, input: KitInput, deps: KitDeps): Result<Kit> {
	if (tool === "warden") return wardenKit(input, deps);
	if (tool === "argent") return argentKit(deps);
	return agentDeviceKit(input, deps);
}
