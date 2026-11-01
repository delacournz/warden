import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { metroTools } from "@delacour/warden-builds/metro";
import type { ConsoleLine, NetworkEntry } from "@delacour/warden-devtools/devtools.types";
import { devtoolsFacetOpener } from "@delacour/warden-devtools/facet";
import { routeReader } from "@delacour/warden-devtools/route";
import {
	CONSOLE_FILE,
	DEFAULT_TAIL,
	type DevtoolsDeps,
	devtoolsOps,
	type LogsParams,
	NETWORK_FILE,
	NETWORK_INCLUDES,
	type NetworkInclude,
} from "@delacour/warden-sdk/ops/devtools";
import { liveness } from "@delacour/warden-store/liveness";
import { processCommand } from "@delacour/warden-store/process-identity";
import { leaseModel } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { uiArgs } from "./args";
import { type BrokerClientDeps, type BrokerTarget, uiBrokerClient } from "./broker-client";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiOutput } from "./output";
import { cliUiPaths } from "./paths";
import { type UiOptionValues, type UiRunEnv, uiRun } from "./run";
import { type SessionExtras, uiSession } from "./session";

export { CONSOLE_FILE, NETWORK_FILE };

const COLLECT_HINT = "run `warden ui logs start` first";

/** The SDK's devtools deps plus how a live `warden dev` session's broker is found and called (default: the registry and the real socket). */
export type CliDevtoolsDeps = DevtoolsDeps & { brokerClient?: BrokerClientDeps };

export const defaultDevtoolsDeps: CliDevtoolsDeps = {
	open: (options) => devtoolsFacetOpener.open(options),
	probe: async (host, port) => {
		const owner = await metroTools.owner(host.exec, port, host.cwd);
		if (owner.kind === "ours") return "ours";
		return owner.kind === "foreign" ? "foreign" : "none";
	},
	collector: {
		self: selfCommand,
		spawnDetached: ({ cmd, logPath }) => {
			const log = openSync(logPath, "a");
			try {
				const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: log, stderr: log, detached: true });
				proc.unref();
				return { pid: proc.pid };
			} finally {
				closeSync(log);
			}
		},
		kill: (pid, signal) => {
			try {
				process.kill(pid, signal);
			} catch {
				// already gone
			}
		},
		pidAlive: liveness.processAlive,
		command: processCommand,
	},
};

type MetroOption = { metro?: string };
type DevtoolsOptionValues = UiOptionValues & MetroOption;

type EvalOptionValues = DevtoolsOptionValues & { await?: true };

type TreeOptionValues = DevtoolsOptionValues & { all?: true; max?: string; screen?: string };

/** The filter flags `logs`, `exceptions` and `network` share. */
type FilterOptionValues = { since?: string; level?: string; grep?: string; limit?: string; status?: string };

type LogsOptionValues = DevtoolsOptionValues & FilterOptionValues & { bodies?: true };

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type Level = (typeof LEVELS)[number];
const SEVERITY: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

type LineFilter = { since?: number; level?: Level; grep?: string; limit: number; kind?: ConsoleLine["kind"] };

type LinesData = { file: string; total: number; lines: ConsoleLine[] };

type ExceptionsOptionValues = UiOptionValues & Pick<FilterOptionValues, "since" | "limit">;

type NetworkOptionValues = UiOptionValues & FilterOptionValues & { include?: string; id?: string };

type NetworkFilter = { since?: number; urlGrep?: string; status?: number | string; limit: number };

export class UiDevtoolsCli {
	devtoolsDeps(deps: UiDeps): CliDevtoolsDeps {
		return deps.devtools ?? defaultDevtoolsDeps;
	}

	/** The devtools session extras: the Metro/collector deps (real ones unless a test injects) and this owner's leased ports. */
	extrasFor(ctx: CommandContext, deps: UiDeps, device: UiDevice): SessionExtras {
		return {
			devtools: {
				...this.devtoolsDeps(deps),
				broker: uiBrokerClient.brokerPortFor(ctx.env, device.udid, this.devtoolsDeps(deps).brokerClient),
			},
			ports: () =>
				ctx
					.store()
					.listLeases()
					.flatMap((lease) =>
						lease.resource.kind === "port" && leaseModel.sameOwner(lease.owner, device.lease.owner)
							? [lease.resource.port]
							: []
					),
		};
	}

	private infoOf(device: UiDevice) {
		return { udid: device.udid, platform: device.platform, name: device.name };
	}

	/**
	 * Runs `run` against the dev session's broker for this device. Undefined = go direct: `--metro` named a Metro, no
	 * broker answers, or its socket vanished mid-call.
	 */
	private async tryBroker<T>(
		ctx: CommandContext,
		deps: UiDeps,
		device: UiDevice,
		opts: MetroOption,
		run: (target: BrokerTarget) => Promise<Result<T, UiError>>
	): Promise<Result<T, UiError> | undefined> {
		if (opts.metro !== undefined) return undefined;
		const handle = await uiBrokerClient.brokerFor(ctx.env, device.udid, this.devtoolsDeps(deps).brokerClient);
		if (handle === undefined) return undefined;
		const done = await run({ env: ctx.env, udid: device.udid, handle });
		return !done.success && uiBrokerClient.brokerGone(done.error) ? undefined : done;
	}

	private renderValue(value: unknown): string {
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value;
		return JSON.stringify(value, null, 2) ?? String(value);
	}

	/** `warden ui eval <expr> [--await]`: run JavaScript in the app and print the value (through the dev session's broker when one runs). */
	uiEval(ctx: CommandContext, deps: UiDeps, expression: string, opts: EvalOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "eval", opts, async (device, env) => {
			const via = await this.tryBroker(ctx, deps, device, opts, (target) =>
				uiBrokerClient.evalExpr(target, { expression, timeoutMs: env.timeoutMs }, this.devtoolsDeps(deps).brokerClient)
			);
			if (via !== undefined) {
				return via.success
					? resultFactory.ok({
							device: this.infoOf(device),
							result: { value: via.data.value },
							text: this.renderValue(via.data.value),
						})
					: via;
			}
			return uiSession.reply(
				device,
				await devtoolsOps.evaluate(uiSession.opSessionFor(ctx, deps, device, env, this.extrasFor(ctx, deps, device)), {
					expression,
					await: opts.await === true,
					...(opts.metro === undefined ? {} : { metro: opts.metro }),
				})
			);
		});
	}

	/** Android reports dp, `warden ui snapshot` speaks px: ask the driver for the scale. */
	private async pixelRatioFor(device: UiDevice, env: UiRunEnv): Promise<number> {
		if (device.platform !== "android") return 1;
		const driver = await env.driver();
		if (!driver.success) return 1;
		const snapshot = await driver.data.snapshot();
		return snapshot.success ? snapshot.data.screen.scale : 1;
	}

	private treeHeader(tree: {
		screen?: string | undefined;
		components: readonly unknown[];
		truncated?: boolean;
	}): string {
		const screen = tree.screen === undefined ? "screen unknown" : `screen ${tree.screen}`;
		return `# ${screen} · ${tree.components.length} components${tree.truncated ? " (truncated)" : ""}`;
	}

	/** The tree from the dev session's broker; undefined = go direct (it has no inactive-screen or per-screen view). */
	private async treeViaBroker(
		ctx: CommandContext,
		deps: UiDeps,
		device: UiDevice,
		opts: TreeOptionValues,
		max: number | undefined,
		pixelRatio: number
	): Promise<Result<UiSuccess, UiError> | undefined> {
		if (opts.all === true || opts.screen !== undefined) return undefined;
		const via = await this.tryBroker(ctx, deps, device, opts, (target) =>
			uiBrokerClient.readTree(
				target,
				{ ...(max === undefined ? {} : { max }), pixelRatio },
				this.devtoolsDeps(deps).brokerClient
			)
		);
		if (via === undefined || !via.success) return via;
		const { lines, ...components } = via.data;
		return resultFactory.ok({
			device: this.infoOf(device),
			result: components,
			text: [this.treeHeader(components), ...lines].join("\n"),
			warnings: components.truncated ? ["more components exist; raise --max"] : [],
		});
	}

	/** `warden ui tree [--all] [--max n] [--screen name]`: the app's React components with rects. */
	uiTree(ctx: CommandContext, deps: UiDeps, opts: TreeOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "tree", opts, async (device, env) => {
			const max = opts.max === undefined ? resultFactory.ok(undefined) : uiArgs.positiveInt("--max", opts.max);
			if (!max.success) return max;
			const via = await this.treeViaBroker(ctx, deps, device, opts, max.data, await this.pixelRatioFor(device, env));
			if (via !== undefined) return via;
			return uiSession.reply(
				device,
				await devtoolsOps.tree(uiSession.opSessionFor(ctx, deps, device, env, this.extrasFor(ctx, deps, device)), {
					all: opts.all === true,
					...(max.data === undefined ? {} : { max: max.data }),
					...(opts.screen === undefined ? {} : { screen: opts.screen }),
					...(opts.metro === undefined ? {} : { metro: opts.metro }),
				})
			);
		});
	}

	/** `warden ui reload`: reload the app's JS (Fast Refresh does not need it; this restarts the bundle). */
	uiReload(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "reload", opts, async (device, env) => {
			const via = await this.tryBroker(ctx, deps, device, opts, (target) =>
				uiBrokerClient.reloadApp(target, this.devtoolsDeps(deps).brokerClient)
			);
			if (via !== undefined) {
				return via.success
					? resultFactory.ok({
							device: this.infoOf(device),
							result: { action: "reload", method: via.data.method },
							text: `reloaded (${via.data.method})`,
						})
					: via;
			}
			return uiSession.reply(
				device,
				await devtoolsOps.reload(
					uiSession.opSessionFor(ctx, deps, device, env, this.extrasFor(ctx, deps, device)),
					opts.metro === undefined ? {} : { metro: opts.metro }
				)
			);
		});
	}

	private readJsonl<T>(path: string): T[] {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return [];
		}
		const rows: T[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				rows.push(JSON.parse(line) as T);
			} catch {
				// a torn last line while the collector is writing
			}
		}
		return rows;
	}

	private clock(ts: number): string {
		return new Date(ts).toISOString().slice(11, 23);
	}

	private readonly consoleLine = (line: ConsoleLine): string => {
		const mark = line.kind === "note" ? "--" : line.kind === "exception" ? "!!" : line.level;
		return `${this.clock(line.ts)} ${mark} ${line.text}`;
	};

	/** `--since --level --grep --limit` (or the positional `n`) as a query; a bad value is a usage error. */
	private parseLineFilter(
		ctx: CommandContext,
		opts: FilterOptionValues,
		fallbackLimit: number
	): Result<LineFilter, WardenError> {
		const since =
			opts.since === undefined ? resultFactory.ok(undefined) : uiBrokerClient.parseSince(opts.since, ctx.now());
		if (!since.success) return since;
		const limit =
			opts.limit === undefined ? resultFactory.ok(fallbackLimit) : uiArgs.positiveInt("--limit", opts.limit);
		if (!limit.success) return limit;
		const level = opts.level;
		if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `unknown --level ${level}`, { hint: LEVELS.join(" | ") }),
			};
		}
		return resultFactory.ok({
			limit: limit.data,
			...(since.data === undefined ? {} : { since: since.data }),
			...(level === undefined ? {} : { level: level as Level }),
			...(opts.grep === undefined ? {} : { grep: opts.grep }),
		});
	}

	/** The collector file's rows through the same filter the broker applies; `total` counts the matches. */
	private filterLines(all: ConsoleLine[], f: LineFilter) {
		const grep = f.grep?.toLowerCase();
		const minimum = f.level === undefined ? undefined : SEVERITY[f.level];
		const matched = all.filter(
			(line) =>
				(f.since === undefined || line.ts >= f.since) &&
				(f.kind === undefined || line.kind === f.kind) &&
				(minimum === undefined || (SEVERITY[line.level] ?? 0) >= minimum) &&
				(grep === undefined || line.text.toLowerCase().includes(grep))
		);
		return { total: matched.length, lines: matched.slice(-f.limit) };
	}

	/** `warden ui logs start` when a dev session's broker already captures everything: nothing to spawn. */
	private brokerCaptures(device: UiDevice, logDir: string): Result<UiSuccess, UiError> {
		return resultFactory.ok({
			device: this.infoOf(device),
			result: { action: "logs", state: "collecting", via: "broker", logDir },
			text: `the dev session's broker is already capturing console + network (${logDir})`,
		});
	}

	/** The `logs` op's params for the words after `logs`; an unknown word is a usage error. */
	private logsParams(words: readonly string[], opts: LogsOptionValues): Result<LogsParams, UiError> {
		const [action, ...rest] = words;
		if (action === "start") {
			return resultFactory.ok({
				action,
				bodies: opts.bodies === true,
				...(opts.metro === undefined ? {} : { metro: opts.metro }),
			});
		}
		if (action === "stop" || action === "clear") return resultFactory.ok({ action });
		if (action === "mark") return resultFactory.ok({ action, label: rest.join(" ") });
		const count = action === undefined ? resultFactory.ok(DEFAULT_TAIL) : uiArgs.positiveInt("n", action);
		if (!count.success) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `unknown logs action "${action}"`, {
					hint: "logs [n] | start | stop | mark <label> | clear",
				}),
			};
		}
		return resultFactory.ok({ action: "tail", count: count.data });
	}

	private linesPayload(device: UiDevice, data: LinesData): Result<UiSuccess, UiError> {
		return resultFactory.ok({
			device: this.infoOf(device),
			result: { file: data.file, total: data.total, lines: data.lines },
			text: data.lines.map(this.consoleLine).join("\n"),
		});
	}

	/** The collector's console file through `filter`. */
	private linesFromFile(
		ctx: CommandContext,
		device: UiDevice,
		filter: LineFilter,
		keep: (line: ConsoleLine) => boolean = () => true
	): Result<UiSuccess, UiError> {
		const file = join(cliUiPaths.uiDir(ctx, device.udid), CONSOLE_FILE);
		if (!existsSync(file)) {
			return { success: false, error: uiOutput.uiError("usage", "no console log yet", { hint: COLLECT_HINT }) };
		}
		const { total, lines } = this.filterLines(this.readJsonl<ConsoleLine>(file).filter(keep), filter);
		return this.linesPayload(device, { file, total, lines });
	}

	private hasLineFilter(opts: FilterOptionValues): boolean {
		return opts.since !== undefined || opts.level !== undefined || opts.grep !== undefined || opts.limit !== undefined;
	}

	/** `warden ui logs [n]`: the last `n` console lines, filtered; the broker answers when a dev session runs. */
	private async logsTail(
		ctx: CommandContext,
		deps: UiDeps,
		device: UiDevice,
		action: string | undefined,
		opts: LogsOptionValues
	): Promise<Result<UiSuccess, UiError> | undefined> {
		const count = action === undefined ? resultFactory.ok(DEFAULT_TAIL) : uiArgs.positiveInt("n", action);
		if (!count.success) return undefined;
		const filter = this.parseLineFilter(ctx, opts, count.data);
		if (!filter.success) return filter;
		const { limit, ...query } = filter.data;
		const via = await this.tryBroker(ctx, deps, device, opts, (target) =>
			uiBrokerClient.queryConsole(target, { ...query, limit }, this.devtoolsDeps(deps).brokerClient)
		);
		if (via !== undefined) return via.success ? this.linesPayload(device, via.data) : via;
		return this.hasLineFilter(opts) ? this.linesFromFile(ctx, device, filter.data) : undefined;
	}

	/**
	 * `warden ui logs [n] | start [--bodies] | stop | mark <label> | clear`. `start` runs a detached collector
	 * (`warden ui-collect`) unless a dev session's broker already captures everything; reads go through the broker when
	 * one runs, else the collector's files.
	 */
	uiLogs(ctx: CommandContext, deps: UiDeps, words: string[], opts: LogsOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "logs", opts, async (device, env) => {
			const [action] = words;
			if (action === "start" && opts.metro === undefined) {
				const broker = await uiBrokerClient.brokerFor(ctx.env, device.udid, this.devtoolsDeps(deps).brokerClient);
				if (broker !== undefined) return this.brokerCaptures(device, broker.session.logDir);
			}
			if (action === undefined || /^\d+$/.test(action)) {
				const tailed = await this.logsTail(ctx, deps, device, action, opts);
				if (tailed !== undefined) return tailed;
			}
			const params = this.logsParams(words, opts);
			if (!params.success) return params;
			return uiSession.reply(
				device,
				await devtoolsOps.logs(
					uiSession.opSessionFor(ctx, deps, device, env, this.extrasFor(ctx, deps, device)),
					params.data
				)
			);
		});
	}

	/** `warden ui exceptions [--since] [--limit]`: the app's uncaught exceptions (broker, else the collector's file). */
	uiExceptions(ctx: CommandContext, deps: UiDeps, opts: ExceptionsOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "exceptions", opts, async (device) => {
			const filter = this.parseLineFilter(ctx, opts, DEFAULT_TAIL);
			if (!filter.success) return filter;
			const { limit, since } = filter.data;
			const via = await this.tryBroker(ctx, deps, device, {}, (target) =>
				uiBrokerClient.queryExceptions(
					target,
					{ limit, ...(since === undefined ? {} : { since }) },
					this.devtoolsDeps(deps).brokerClient
				)
			);
			if (via !== undefined) return via.success ? this.linesPayload(device, via.data) : via;
			const { isAppException } = await import("../dev-broker/exceptions");
			return this.linesFromFile(ctx, device, filter.data, isAppException);
		});
	}

	/** `warden ui route`: the route key of the screen the app is on (broker, else a direct connection). */
	uiRoute(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "route", opts, async (device, env) => {
			const routePayload = (route: string | null): Result<UiSuccess, UiError> =>
				resultFactory.ok({ device: this.infoOf(device), result: { route }, text: route ?? "(none)" });
			const via = await this.tryBroker(ctx, deps, device, opts, (target) =>
				uiBrokerClient.readRoute(target, this.devtoolsDeps(deps).brokerClient)
			);
			if (via !== undefined) return via.success ? routePayload(via.data.route) : via;
			const session = uiSession.opSessionFor(ctx, deps, device, env, this.extrasFor(ctx, deps, device));
			const read = await devtoolsOps.withFacet(session, opts, async (facet) => {
				const found = await routeReader.read(facet);
				return found.success
					? resultFactory.ok(found.data ?? null)
					: { success: false, error: devtoolsOps.devtoolsError(found.error) };
			});
			return read.success ? routePayload(read.data) : read;
		});
	}

	/** `warden ui devtools status`: the dev session's broker (attached, yielded to DevTools, lost, ...). */
	uiDevtoolsStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "devtools status", opts, async (device) => {
			const status = await uiBrokerClient.devtoolsStatus(
				{ env: ctx.env, udid: device.udid },
				this.devtoolsDeps(deps).brokerClient
			);
			if (!status.success) return status;
			const { state, console: lines, network: net, session } = status.data;
			const where = state.phase === "attached" ? ` (${state.deviceName})` : "";
			const why = state.phase === "yielded" ? `: ${state.reason}` : state.phase === "lost" ? `: ${state.error}` : "";
			return resultFactory.ok({
				device: this.infoOf(device),
				result: status.data,
				text: [
					`broker ${state.phase}${where}${why}`,
					`metro ${session.metroUrl} · pid ${status.data.pid}`,
					`console ${lines.buffered} buffered / ${lines.total} total · network ${net.buffered} / ${net.total}`,
					`methods ${status.data.methods.join(", ")}`,
				].join("\n"),
			});
		});
	}

	/** `warden ui devtools resume`: take the page back after the broker yielded to Chrome DevTools. */
	uiDevtoolsResume(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "devtools resume", opts, async (device) => {
			const resumed = await uiBrokerClient.devtoolsResume(
				{ env: ctx.env, udid: device.udid },
				this.devtoolsDeps(deps).brokerClient
			);
			if (!resumed.success) return resumed;
			return resultFactory.ok({
				device: this.infoOf(device),
				result: { action: "resume", state: resumed.data.state },
				text: `broker ${resumed.data.state.phase}`,
			});
		});
	}

	/** `--since --grep --status --limit` (or the positional `n`) for the network log. */
	private parseNetworkFilter(
		ctx: CommandContext,
		opts: FilterOptionValues,
		fallbackLimit: number
	): Result<NetworkFilter, WardenError> {
		const base = this.parseLineFilter(ctx, { ...opts, level: undefined }, fallbackLimit);
		if (!base.success) return base;
		const raw = opts.status;
		if (raw !== undefined && !/^([1-5]xx|\d{3})$/.test(raw)) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `--status must be a code (404) or a class (4xx), got "${raw}"`),
			};
		}
		return resultFactory.ok({
			limit: base.data.limit,
			...(base.data.since === undefined ? {} : { since: base.data.since }),
			...(base.data.grep === undefined ? {} : { urlGrep: base.data.grep }),
			...(raw === undefined ? {} : { status: /^\d{3}$/.test(raw) ? Number(raw) : raw }),
		});
	}

	/** The broker's `network.query` filter applied to a collector row. */
	private networkMatches(entry: NetworkEntry, f: NetworkFilter): boolean {
		const wanted = f.status;
		const statusOk =
			wanted === undefined ||
			(typeof wanted === "number" ? entry.status === wanted : Math.floor(entry.status / 100) === Number(wanted[0]));
		return (
			(f.since === undefined || entry.ts >= f.since) &&
			(f.urlGrep === undefined || entry.url.toLowerCase().includes(f.urlGrep.toLowerCase())) &&
			statusOk
		);
	}

	private networkLine(entry: NetworkEntry): string {
		const status = entry.status === 0 ? "ERR" : String(entry.status);
		return `#${entry.id} ${entry.method} ${entry.url} ${status} ${entry.durationMs}ms${entry.error ? ` ${entry.error}` : ""}`;
	}

	private headerLines(label: string, headers: Record<string, string>): string[] {
		return Object.entries(headers).map(([name, value]) => `    ${label} ${name}: ${value}`);
	}

	private networkDetail(entry: NetworkEntry, include: ReadonlySet<string>): string {
		const lines = [this.networkLine(entry)];
		if (include.has("headers")) {
			lines.push(...this.headerLines(">", entry.requestHeaders), ...this.headerLines("<", entry.responseHeaders));
		}
		if (include.has("body")) {
			if (entry.requestBody !== undefined) lines.push(`    > body ${entry.requestBody}`);
			if (entry.responseBody !== undefined) {
				lines.push(`    < body ${entry.responseBody}${entry.responseBodyTruncated ? " (truncated)" : ""}`);
			}
		}
		return lines.join("\n");
	}

	private networkPayload(
		device: UiDevice,
		data: { file: string; total: number; entries: NetworkEntry[] },
		include: ReadonlySet<string>
	): Result<UiSuccess, UiError> {
		return resultFactory.ok({
			device: this.infoOf(device),
			result: { file: data.file, total: data.total, entries: data.entries },
			text: data.entries.map((entry) => this.networkDetail(entry, include)).join("\n"),
		});
	}

	/** `warden ui network --id <id>`: one entry with headers and bodies. */
	private networkEntry(device: UiDevice, entry: NetworkEntry | undefined, id: number): Result<UiSuccess, UiError> {
		if (!entry) {
			return {
				success: false,
				error: uiOutput.uiError("target_not_found", `no network entry #${id}`, {
					hint: "`warden ui network` lists ids",
				}),
			};
		}
		return resultFactory.ok({
			device: this.infoOf(device),
			result: { entry },
			text: this.networkDetail(entry, new Set(NETWORK_INCLUDES)),
		});
	}

	/** `network` from the dev session's broker; undefined = read the collector's file. */
	private async networkViaBroker(
		deps: UiDeps,
		device: UiDevice,
		ctx: CommandContext,
		id: number | undefined,
		filter: NetworkFilter,
		include: ReadonlySet<string>
	): Promise<Result<UiSuccess, UiError> | undefined> {
		const brokerDeps = this.devtoolsDeps(deps).brokerClient;
		if (id !== undefined) {
			const via = await this.tryBroker(ctx, deps, device, {}, (target) =>
				uiBrokerClient.networkEntryById(target, id, brokerDeps)
			);
			return via === undefined ? undefined : via.success ? this.networkEntry(device, via.data, id) : via;
		}
		const { limit, since, urlGrep, status } = filter;
		const query = {
			limit,
			...(since === undefined ? {} : { since }),
			...(urlGrep === undefined ? {} : { urlGrep }),
			...(status === undefined ? {} : { status }),
		};
		const via = await this.tryBroker(ctx, deps, device, {}, (target) =>
			uiBrokerClient.queryNetwork(target, query, brokerDeps)
		);
		return via === undefined ? undefined : via.success ? this.networkPayload(device, via.data, include) : via;
	}

	private hasNetworkFilter(opts: FilterOptionValues): boolean {
		return opts.since !== undefined || opts.grep !== undefined || opts.status !== undefined || opts.limit !== undefined;
	}

	/** `warden ui network [n] [--include headers,body] [--id <id>] [--since --grep --status --limit]`: the app's `fetch` calls (broker, else the collector's file). */
	uiNetwork(
		ctx: CommandContext,
		deps: UiDeps,
		countArg: string | undefined,
		opts: NetworkOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, "network", opts, async (device, env) => {
			const includeParts = (opts.include ?? "").split(",").filter((part) => part !== "");
			const unknown = includeParts.filter((part) => !(NETWORK_INCLUDES as readonly string[]).includes(part));
			if (unknown.length > 0) {
				return {
					success: false,
					error: uiOutput.uiError("usage", `unknown --include ${unknown.join(",")}`, { hint: "headers,body" }),
				};
			}
			const count = countArg === undefined ? resultFactory.ok(DEFAULT_TAIL) : uiArgs.positiveInt("n", countArg);
			if (!count.success) return count;
			const id = opts.id === undefined ? resultFactory.ok(undefined) : uiArgs.positiveInt("--id", opts.id);
			if (!id.success) return id;
			const filter = this.parseNetworkFilter(ctx, opts, count.data);
			if (!filter.success) return filter;
			const include = new Set(includeParts);
			const via = await this.networkViaBroker(deps, device, ctx, id.data, filter.data, include);
			if (via !== undefined) return via;
			if (id.data === undefined && this.hasNetworkFilter(opts)) {
				const file = join(cliUiPaths.uiDir(ctx, device.udid), NETWORK_FILE);
				if (!existsSync(file)) {
					return { success: false, error: uiOutput.uiError("usage", "no network log yet", { hint: COLLECT_HINT }) };
				}
				const matched = this.readJsonl<NetworkEntry>(file).filter((entry) => this.networkMatches(entry, filter.data));
				return this.networkPayload(
					device,
					{ file, total: matched.length, entries: matched.slice(-filter.data.limit) },
					include
				);
			}
			return uiSession.reply(
				device,
				await devtoolsOps.network(uiSession.opSessionFor(ctx, deps, device, env), {
					count: count.data,
					include: includeParts as NetworkInclude[],
					...(id.data === undefined ? {} : { id: id.data }),
				})
			);
		});
	}
}

export const uiDevtoolsCli = new UiDevtoolsCli();
