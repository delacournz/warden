import { ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { parseSince } from "../commands/dev-logs";
import { listDevSessions } from "../dev-session";
import { METRO_LOG_KINDS } from "../dev-tui/metro-log";
import { parseMetroLogKinds, readMetroLogs } from "../metro-logs";

type Env = Record<string, string | undefined>;

/** Why a tool call failed; `hint` says what to do about it. */
export type ToolError = { code: string; message: string; hint?: string };

export type ToolResult = Result<unknown, ToolError>;

/**
 * One MCP tool: a zod shape for its input and the plain function it calls. The functions are the same ones the CLI
 * verbs call, so the MCP layer adds no behaviour of its own.
 */
export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> = {
	name: string;
	description: string;
	input: S;
	run: (env: Env, args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
};

/** Keeps each tool's `run` typed by its own shape while the table holds them all. */
function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
	return def as unknown as ToolDef;
}

const udid = z.string().optional().describe("device udid/serial; default = the only live `warden dev` session");
const sinceArg = z.string().optional().describe("duration (30s, 5m) or ISO time");

/** `since` as epoch ms, or the `invalid_query` error the tool returns. */
function since(value: string | undefined, now: number): Result<number | undefined, ToolError> {
	if (value === undefined) return ok(undefined);
	const parsed = parseSince(value, now);
	if (parsed.ok) return ok(parsed.ms);
	return { success: false, error: { code: "invalid_query", message: parsed.message.replace("--since", "since") } };
}

export type ToolDeps = { now: () => number };

/** Every tool `warden mcp` serves. */
export function wardenTools(deps: ToolDeps = { now: () => Date.now() }): ToolDef[] {
	return [
		tool({
			name: "dev_sessions",
			description: "List live `warden dev` sessions (device, Metro URL, log dir, devtools broker).",
			input: {},
			run: async (env) => listDevSessions(env),
		}),
		tool({
			name: "metro_logs",
			description:
				"Metro bundler output of a `warden dev` session, classified: bundle_start/done/failed, hmr, error, warn, info. Bundle and transform errors (with code frames) only show up here, never in the app console.",
			input: {
				udid,
				since: sinceArg,
				tail: z.number().int().positive().optional().describe("last N entries"),
				grep: z.string().optional().describe("regex on the line text"),
				kinds: z
					.array(z.string())
					.optional()
					.describe(`any of ${METRO_LOG_KINDS.join(", ")}`),
			},
			run: async (env, args) => {
				const from = since(args.since, deps.now());
				if (!from.success) return from;
				const kinds = args.kinds === undefined ? undefined : parseMetroLogKinds(args.kinds.join(","));
				if (kinds !== undefined && !kinds.success) return kinds;
				return readMetroLogs(env, {
					...(args.udid !== undefined ? { udid: args.udid } : {}),
					...(from.data !== undefined ? { sinceMs: from.data } : {}),
					...(args.tail !== undefined ? { tail: args.tail } : {}),
					...(args.grep !== undefined ? { grep: args.grep } : {}),
					...(kinds !== undefined ? { kinds: kinds.data } : {}),
				});
			},
		}),
	];
}
