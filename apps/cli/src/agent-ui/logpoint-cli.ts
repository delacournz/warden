import type { Command as Commander } from "@commander-js/extra-typings";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { LogpointAddParams, LogpointInfo } from "../dev-broker/logpoints";
import { type BrokerCall, type BrokerClientDeps, type BrokerTarget, uiBrokerClient } from "./broker-client";
import { type UiError, uiOutput } from "./output";

/** `[logpoint:` opens the first argument of every hit; kept in step with `dev-broker/logpoints.ts` (not imported: it loads zod). */
const TAG_PREFIX = "[logpoint:";
const DEFAULT_HITS_LIMIT = 50;

/** One logged value of a logpoint. */
export type LogpointHit = { id: string; ts: number; value: string; error: boolean; args: string[] };

export type LogpointHitsQuery = {
	/** only this logpoint (default: all) */
	id?: string;
	/** epoch ms */
	since?: number;
	/** the newest n hits (default 50) */
	limit?: number;
};

type LogpointOptionValues = { udid?: string; json?: true };

type Rendered = { result: unknown; text: string; warnings?: string[] };

export class UiLogpointCli {
	private readonly lazyCall: BrokerCall = async (socketPath, request, options) => {
		const { devBrokerIpc } = await import("../dev-broker/ipc");
		return devBrokerIpc.callBroker(socketPath, request, options);
	};

	/** Call a `logpoint.*` method on the broker `target` resolves to. */
	private async callLogpoint<T>(
		target: BrokerTarget,
		deps: BrokerClientDeps,
		method: string,
		params: unknown
	): Promise<Result<T, UiError>> {
		const handle = await uiBrokerClient.resolveBroker(target, deps);
		if (!handle.success) return handle;
		const reply = await (deps.call ?? this.lazyCall)(handle.data.socketPath, { method, params });
		return reply.success
			? resultFactory.ok(reply.data as T)
			: { success: false, error: uiBrokerClient.brokerUiError(reply.error) };
	}

	/** Add a logpoint; `location` is `src/x.tsx:42[:col]` (a path suffix inside the bundle). */
	addLogpoint(
		target: BrokerTarget,
		params: LogpointAddParams,
		deps: BrokerClientDeps = {}
	): Promise<Result<{ logpoint: LogpointInfo }, UiError>> {
		return this.callLogpoint(target, deps, "logpoint.add", params);
	}

	/** Every logpoint of the dev session. */
	listLogpoints(
		target: BrokerTarget,
		deps: BrokerClientDeps = {}
	): Promise<Result<{ logpoints: LogpointInfo[] }, UiError>> {
		return this.callLogpoint(target, deps, "logpoint.list", {});
	}

	/** Remove one logpoint by id. */
	removeLogpoint(
		target: BrokerTarget,
		params: { id: string },
		deps: BrokerClientDeps = {}
	): Promise<Result<{ removed: string }, UiError>> {
		return this.callLogpoint(target, deps, "logpoint.remove", params);
	}

	/** Remove every logpoint. */
	clearLogpoints(target: BrokerTarget, deps: BrokerClientDeps = {}): Promise<Result<{ removed: string[] }, UiError>> {
		return this.callLogpoint(target, deps, "logpoint.clear", {});
	}

	/** The hits so far: the app's console lines carrying a logpoint tag, newest last. */
	async logpointHits(
		target: BrokerTarget,
		query: LogpointHitsQuery = {},
		deps: BrokerClientDeps = {}
	): Promise<Result<{ hits: LogpointHit[]; total: number }, UiError>> {
		const limit = query.limit ?? DEFAULT_HITS_LIMIT;
		const lines = await uiBrokerClient.queryConsole(
			target,
			{
				grep: query.id === undefined ? TAG_PREFIX : `${TAG_PREFIX}${query.id}]`,
				...(query.since === undefined ? {} : { since: query.since }),
				kind: "console",
				limit,
			},
			deps
		);
		if (!lines.success) return lines;
		const hits = lines.data.lines.flatMap((line): LogpointHit[] => {
			if (!line.text.startsWith(TAG_PREFIX)) return [];
			const end = line.text.indexOf("]");
			if (end < 0) return [];
			const id = line.text.slice(TAG_PREFIX.length, end);
			if (query.id !== undefined && id !== query.id) return [];
			const rest = line.text.slice(end + 1).trim();
			const error = rest.startsWith("error ") || rest === "error";
			return [
				{ id, ts: line.ts, value: error ? rest.slice("error".length).trim() : rest, error, args: line.args ?? [] },
			];
		});
		return resultFactory.ok({ hits, total: lines.data.total });
	}

	/**
	 * The frame of a `warden ui logpoint …` verb: find the dev session's broker (`--udid` picks one of several), run
	 * `work`, print text or the one `--json` envelope. No device lease is touched: the broker belongs to `warden dev`.
	 */
	private async runLogpoint(
		ctx: CommandContext,
		deps: BrokerClientDeps,
		command: string,
		opts: LogpointOptionValues,
		work: (target: BrokerTarget) => Promise<Result<Rendered, UiError>>
	): Promise<number> {
		const report = { command, json: opts.json === true, startedAt: ctx.now() };
		try {
			const handle = await uiBrokerClient.resolveBroker(
				{ env: ctx.env, ...(opts.udid === undefined ? {} : { udid: opts.udid }) },
				deps
			);
			if (!handle.success) return uiOutput.reportError(ctx, report, handle.error);
			const device = { udid: handle.data.session.deviceId, platform: handle.data.session.platform };
			const done = await work({ env: ctx.env, handle: handle.data });
			if (!done.success) return uiOutput.reportError(ctx, report, done.error, device);
			return uiOutput.reportOk(ctx, report, { device, ...done.data });
		} catch (error) {
			return uiOutput.reportError(
				ctx,
				report,
				uiOutput.uiError("failed", error instanceof Error ? error.message : String(error))
			);
		}
	}

	private readonly describeLogpoint = (lp: LogpointInfo): string => {
		const where = lp.resolved ? `${lp.resolved.source}:${lp.resolved.line}:${lp.resolved.col}` : lp.location;
		const state = lp.armed ? "armed" : "pending";
		const hits = lp.hits === undefined ? `${lp.hitCount} hits` : `${lp.hitCount}/${lp.hits} hits`;
		return `${lp.id}  ${state}  ${where}  ${hits}  ${lp.expression}${lp.error ? `  (${lp.error})` : ""}`;
	};

	private clock(ts: number): string {
		return new Date(ts).toISOString().slice(11, 23);
	}

	/** `warden ui logpoint add <location> <expression> [--id] [--hits n]`. */
	uiLogpointAdd(
		ctx: CommandContext,
		deps: BrokerClientDeps,
		location: string,
		expression: string,
		opts: LogpointOptionValues & { id?: string; hits?: string }
	): Promise<number> {
		return this.runLogpoint(ctx, deps, "logpoint add", opts, async (target) => {
			if (opts.hits !== undefined && !/^[1-9]\d*$/.test(opts.hits)) {
				return {
					success: false,
					error: uiOutput.uiError("usage", `--hits must be a positive integer, got "${opts.hits}"`),
				};
			}
			const added = await this.addLogpoint(
				target,
				{
					location,
					expression,
					...(opts.id === undefined ? {} : { id: opts.id }),
					...(opts.hits === undefined ? {} : { hits: Number(opts.hits) }),
				},
				deps
			);
			if (!added.success) return added;
			const { logpoint } = added.data;
			return resultFactory.ok({
				result: added.data,
				text: this.describeLogpoint(logpoint),
				...(logpoint.armed ? {} : { warnings: [logpoint.error ?? "not armed yet"] }),
			});
		});
	}

	/** `warden ui logpoint list`. */
	uiLogpointList(ctx: CommandContext, deps: BrokerClientDeps, opts: LogpointOptionValues): Promise<number> {
		return this.runLogpoint(ctx, deps, "logpoint list", opts, async (target) => {
			const listed = await this.listLogpoints(target, deps);
			if (!listed.success) return listed;
			const { logpoints } = listed.data;
			return resultFactory.ok({
				result: listed.data,
				text: logpoints.length === 0 ? "no logpoints" : logpoints.map(this.describeLogpoint).join("\n"),
			});
		});
	}

	/** `warden ui logpoint rm <id>`. */
	uiLogpointRemove(
		ctx: CommandContext,
		deps: BrokerClientDeps,
		id: string,
		opts: LogpointOptionValues
	): Promise<number> {
		return this.runLogpoint(ctx, deps, "logpoint rm", opts, async (target) => {
			const removed = await this.removeLogpoint(target, { id }, deps);
			return removed.success
				? resultFactory.ok({ result: removed.data, text: `removed ${removed.data.removed}` })
				: removed;
		});
	}

	/** `warden ui logpoint clear`. */
	uiLogpointClear(ctx: CommandContext, deps: BrokerClientDeps, opts: LogpointOptionValues): Promise<number> {
		return this.runLogpoint(ctx, deps, "logpoint clear", opts, async (target) => {
			const cleared = await this.clearLogpoints(target, deps);
			if (!cleared.success) return cleared;
			const n = cleared.data.removed.length;
			return resultFactory.ok({ result: cleared.data, text: `removed ${n} logpoint${n === 1 ? "" : "s"}` });
		});
	}

	/** `hits`' flags as a query: `--since` as epoch ms, `--limit` as a positive integer. */
	private hitsQuery(
		id: string | undefined,
		opts: { since?: string; limit?: string },
		now: number
	): Result<LogpointHitsQuery, UiError> {
		let since: number | undefined;
		if (opts.since !== undefined) {
			const parsed = uiBrokerClient.parseSince(opts.since, now);
			if (!parsed.success) return parsed;
			since = parsed.data;
		}
		if (opts.limit !== undefined && !/^[1-9]\d*$/.test(opts.limit)) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `--limit must be a positive integer, got "${opts.limit}"`),
			};
		}
		return resultFactory.ok({
			...(id === undefined ? {} : { id }),
			...(since === undefined ? {} : { since }),
			...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }),
		});
	}

	/** `warden ui logpoint hits [<id>] [--since 30s] [--limit n]`. */
	uiLogpointHits(
		ctx: CommandContext,
		deps: BrokerClientDeps,
		id: string | undefined,
		opts: LogpointOptionValues & { since?: string; limit?: string }
	): Promise<number> {
		return this.runLogpoint(ctx, deps, "logpoint hits", opts, async (target) => {
			const query = this.hitsQuery(id, opts, ctx.now());
			if (!query.success) return query;
			const found = await this.logpointHits(target, query.data, deps);
			if (!found.success) return found;
			const text = found.data.hits
				.map((hit) => `${this.clock(hit.ts)} [${hit.id}]${hit.error ? " error" : ""} ${hit.value}`)
				.join("\n");
			return resultFactory.ok({ result: found.data, text: text === "" ? "no hits yet" : text });
		});
	}

	private withOptions<
		Args extends unknown[],
		Opts extends Record<string, unknown>,
		Globals extends Record<string, unknown>,
	>(cmd: Commander<Args, Opts, Globals>) {
		return cmd
			.option("--udid <id>", "which dev session (default: the only one)")
			.option("--json", "print one JSON document");
	}

	/**
	 * `warden ui logpoint add|list|rm|clear|hits`. One call from `commands/ui.ts`; the work lives in this module and is
	 * imported when a verb runs. `deps` replaces the dev-session registry and the broker socket in tests.
	 */
	registerLogpoint(
		cmd: Commander,
		ctx: CommandContext,
		done: (code: number) => void,
		deps: BrokerClientDeps = {}
	): void {
		const logpoint = cmd
			.command("logpoint")
			.description("log a value whenever a source line runs, without pausing: add | list | rm | clear | hits");
		this.withOptions(
			logpoint
				.command("add")
				.description("log <expression> each time <file:line[:col]> runs (needs `warden dev` and a Fusebox debugger)")
				.argument("<location>", "src/x.tsx:42 or src/x.tsx:42:7 (path suffix inside the bundle, 1-based)")
				.argument("<expression>", "JavaScript evaluated in the scope of that line")
				.option("--id <id>", "name for it (default lp1, lp2, ...)")
				.option("--hits <n>", "remove it after n hits")
		).action(async (location, expression, opts) => {
			const { uiLogpointCli } = await import("./logpoint-cli");
			done(await uiLogpointCli.uiLogpointAdd(ctx, deps, location, expression, opts));
		});
		this.withOptions(logpoint.command("list").description("the logpoints and whether they are armed")).action(
			async (opts) => {
				const { uiLogpointCli } = await import("./logpoint-cli");
				done(await uiLogpointCli.uiLogpointList(ctx, deps, opts));
			}
		);
		this.withOptions(logpoint.command("rm").description("remove a logpoint").argument("<id>", "logpoint id")).action(
			async (id, opts) => {
				const { uiLogpointCli } = await import("./logpoint-cli");
				done(await uiLogpointCli.uiLogpointRemove(ctx, deps, id, opts));
			}
		);
		this.withOptions(logpoint.command("clear").description("remove every logpoint")).action(async (opts) => {
			const { uiLogpointCli } = await import("./logpoint-cli");
			done(await uiLogpointCli.uiLogpointClear(ctx, deps, opts));
		});
		this.withOptions(
			logpoint
				.command("hits")
				.description("the values logged so far")
				.argument("[id]", "only this logpoint")
				.option("--since <when>", "30s | 5m | 2h | ISO time")
				.option("--limit <n>", "at most the last n hits (default 50)")
		).action(async (id, opts) => {
			const { uiLogpointCli } = await import("./logpoint-cli");
			done(await uiLogpointCli.uiLogpointHits(ctx, deps, id, opts));
		});
	}
}

export const uiLogpointCli = new UiLogpointCli();
