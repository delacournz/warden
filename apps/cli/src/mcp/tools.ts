import { type Result, resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import { uiBrokerClient } from "../agent-ui/broker-client";
import { uiLogpointCli } from "../agent-ui/logpoint-cli";
import { devLogs } from "../commands/dev-logs";
import { devBrokerProfileClient } from "../dev-broker/profile-client";
import { devSession } from "../dev-session";
import { METRO_LOG_KINDS } from "../dev-tui/metro-log";
import { metroLogs } from "../metro-logs";

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

const udid = z.string().optional().describe("device udid/serial; default = the only live `warden dev` session");
const sinceArg = z.string().optional().describe("duration (30s, 5m) or ISO time");
const profileKind = z.enum(["cpu", "heap", "react"]);
const limit = z.number().int().positive().optional().describe("newest N (default 200)");

export type ToolDeps = { now: () => number };

export class McpTools {
	/** Keeps each tool's `run` typed by its own shape while the table holds them all. */
	private tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
		return def as unknown as ToolDef;
	}

	/** The broker target of a tool call: an explicit udid, else the only live dev session. */
	private target(env: Env, udid: string | undefined) {
		return { env, ...(udid !== undefined ? { udid } : {}) };
	}

	/** Copies only the defined keys, so optional query fields stay absent rather than `undefined`. */
	private defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
		return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
			[K in keyof T]?: Exclude<T[K], undefined>;
		};
	}

	/** `since` as epoch ms, or the `invalid_query` error the tool returns. */
	private since(value: string | undefined, now: number): Result<number | undefined, ToolError> {
		if (value === undefined) return resultFactory.ok(undefined);
		const parsed = devLogs.parseSince(value, now);
		if (parsed.ok) return resultFactory.ok(parsed.ms);
		return { success: false, error: { code: "invalid_query", message: parsed.message.replace("--since", "since") } };
	}

	/** Every tool `warden mcp` serves. */
	wardenTools(deps: ToolDeps = { now: () => Date.now() }): ToolDef[] {
		return [
			this.tool({
				name: "dev_sessions",
				description: "List live `warden dev` sessions (device, Metro URL, log dir, devtools broker).",
				input: {},
				run: async (env) => devSession.listDevSessions(env),
			}),
			this.tool({
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
					const from = this.since(args.since, deps.now());
					if (!from.success) return from;
					const kinds = args.kinds === undefined ? undefined : metroLogs.parseMetroLogKinds(args.kinds.join(","));
					if (kinds !== undefined && !kinds.success) return kinds;
					return metroLogs.readMetroLogs(
						env,
						this.defined({ udid: args.udid, sinceMs: from.data, tail: args.tail, grep: args.grep, kinds: kinds?.data })
					);
				},
			}),
			this.tool({
				name: "app_console",
				description:
					"The app's console lines (console.* calls, uncaught exceptions, notes) captured over CDP by the dev session's broker. Stacks are symbolicated to source.",
				input: {
					udid,
					since: sinceArg,
					level: z.enum(["log", "info", "warn", "error", "debug"]).optional(),
					grep: z.string().optional().describe("case-insensitive substring"),
					kind: z.enum(["console", "exception", "note"]).optional(),
					limit,
				},
				run: async (env, { udid: id, since: raw, ...rest }) => {
					const from = this.since(raw, deps.now());
					if (!from.success) return from;
					return uiBrokerClient.queryConsole(this.target(env, id), this.defined({ ...rest, since: from.data }));
				},
			}),
			this.tool({
				name: "app_exceptions",
				description: "The app's uncaught JS exceptions with symbolicated stacks and Metro's code frame.",
				input: { udid, since: sinceArg, limit },
				run: async (env, { udid: id, since: raw, limit: n }) => {
					const from = this.since(raw, deps.now());
					if (!from.success) return from;
					return uiBrokerClient.queryExceptions(this.target(env, id), this.defined({ since: from.data, limit: n }));
				},
			}),
			this.tool({
				name: "app_network",
				description: "The app's fetch calls (Metro's own traffic excluded): method, url, status, timing.",
				input: {
					udid,
					since: sinceArg,
					urlGrep: z.string().optional().describe("case-insensitive URL substring"),
					status: z
						.union([z.number().int(), z.string().regex(/^[1-5]xx$/)])
						.optional()
						.describe("404 or 4xx"),
					limit,
				},
				run: async (env, { udid: id, since: raw, ...rest }) => {
					const from = this.since(raw, deps.now());
					if (!from.success) return from;
					return uiBrokerClient.queryNetwork(this.target(env, id), this.defined({ ...rest, since: from.data }));
				},
			}),
			this.tool({
				name: "app_eval",
				description:
					"Evaluate a JavaScript expression in the running app (Hermes) and return its JSON value; promises are awaited. Use for reading stores, globals, navigation state.",
				input: { udid, expression: z.string().min(1), timeoutMs: z.number().int().positive().optional() },
				run: async (env, { udid: id, expression, timeoutMs }) =>
					uiBrokerClient.evalExpr(this.target(env, id), { expression, ...this.defined({ timeoutMs }) }),
			}),
			this.tool({
				name: "app_tree",
				description: "The app's React component tree on screen (names, testIDs, text, rects).",
				input: {
					udid,
					depth: z.number().int().nonnegative().optional(),
					testID: z.string().optional().describe("only this component's subtree"),
					max: z.number().int().positive().optional().describe("first N components"),
				},
				run: async (env, { udid: id, ...params }) =>
					uiBrokerClient.readTree(this.target(env, id), this.defined(params)),
			}),
			this.tool({
				name: "app_route",
				description: "The route key of the screen the app is on (Expo Router / React Navigation).",
				input: { udid },
				run: async (env, { udid: id }) => uiBrokerClient.readRoute(this.target(env, id)),
			}),
			this.tool({
				name: "app_reload",
				description: "Reload the app's JavaScript bundle.",
				input: { udid },
				run: async (env, { udid: id }) => uiBrokerClient.reloadApp(this.target(env, id)),
			}),
			this.tool({
				name: "devtools_status",
				description:
					"The dev session's CDP broker state: connecting, attached, yielded (Chrome DevTools took the page), lost.",
				input: { udid },
				run: async (env, { udid: id }) => uiBrokerClient.devtoolsStatus(this.target(env, id)),
			}),
			this.tool({
				name: "devtools_resume",
				description:
					"Reattach the broker after it yielded to Chrome DevTools. On a single-debugger Metro this disconnects DevTools.",
				input: { udid },
				run: async (env, { udid: id }) => uiBrokerClient.devtoolsResume(this.target(env, id)),
			}),
			this.tool({
				name: "logpoint_add",
				description:
					"Log an expression's value every time a source line runs, without pausing or editing code (a conditional breakpoint that never stops). Read values with logpoint_hits.",
				input: {
					udid,
					location: z.string().min(1).describe("src/x.tsx:42 or src/x.tsx:42:7 (path suffix, 1-based)"),
					expression: z.string().min(1).describe("JavaScript evaluated in that line's scope"),
					id: z.string().optional(),
					hits: z.number().int().positive().optional().describe("remove after N hits"),
				},
				run: async (env, { udid: device, location, expression, ...rest }) =>
					uiLogpointCli.addLogpoint(this.target(env, device), { location, expression, ...this.defined(rest) }),
			}),
			this.tool({
				name: "logpoint_hits",
				description: "Values logged by logpoints, newest last.",
				input: { udid, id: z.string().optional(), since: sinceArg, limit },
				run: async (env, { udid: device, since: raw, ...rest }) => {
					const from = this.since(raw, deps.now());
					if (!from.success) return from;
					return uiLogpointCli.logpointHits(this.target(env, device), this.defined({ ...rest, since: from.data }));
				},
			}),
			this.tool({
				name: "logpoint_list",
				description: "The session's logpoints, their hit counts and whether they are armed.",
				input: { udid },
				run: async (env, { udid: device }) => uiLogpointCli.listLogpoints(this.target(env, device)),
			}),
			this.tool({
				name: "logpoint_remove",
				description: "Remove one logpoint, or every logpoint when id is omitted.",
				input: { udid, id: z.string().optional() },
				run: async (env, { udid: device, id: logpoint }) =>
					logpoint === undefined
						? uiLogpointCli.clearLogpoints(this.target(env, device))
						: uiLogpointCli.removeLogpoint(this.target(env, device), { id: logpoint }),
			}),
			this.tool({
				name: "profile_start",
				description:
					"Start recording in the running app: cpu (JS sampling profile), heap (allocation sampling) or react (commits). Stop with profile_stop.",
				input: {
					udid,
					kind: profileKind,
					samplingIntervalUs: z.number().int().positive().optional().describe("cpu only (default 100)"),
				},
				run: async (env, { udid: id, kind, samplingIntervalUs }) =>
					devBrokerProfileClient.startProfile(env, { kind, ...this.defined({ udid: id, samplingIntervalUs }) }),
			}),
			this.tool({
				name: "profile_stop",
				description:
					"Stop a recording and get its summary (cpu: top self-time functions; heap: top allocation sites; react: slowest commits/components) plus the artifact path.",
				input: { udid, kind: profileKind },
				run: async (env, { udid: id, kind }) =>
					devBrokerProfileClient.stopProfile(env, { kind, ...this.defined({ udid: id }) }),
			}),
			this.tool({
				name: "profile_status",
				description: "Which recordings are running.",
				input: { udid },
				run: async (env, { udid: id }) => devBrokerProfileClient.profileStatus(env, this.defined({ udid: id })),
			}),
		];
	}
}

export const mcpTools = new McpTools();
