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
	devtoolsError,
	evaluate,
	type LogsParams,
	logs,
	NETWORK_FILE,
	NETWORK_INCLUDES,
	type NetworkInclude,
	network,
	reload,
	tree,
	withFacet,
} from "@delacour/warden-sdk/ops/devtools";
import { liveness } from "@delacour/warden-store/liveness";
import { processCommand } from "@delacour/warden-store/process-identity";
import { leaseModel } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { positiveInt } from "./args";
import {
	type BrokerClientDeps,
	type BrokerTarget,
	brokerFor,
	brokerGone,
	brokerPortFor,
	devtoolsResume,
	devtoolsStatus,
	evalExpr,
	networkEntryById,
	parseSince,
	queryConsole,
	queryExceptions,
	queryNetwork,
	readRoute as readRouteViaBroker,
	readTree,
	reloadApp,
} from "./broker-client";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { uiDir } from "./paths";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { opSessionFor, reply, type SessionExtras } from "./session";

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

export function devtoolsDeps(deps: UiDeps): CliDevtoolsDeps {
	return deps.devtools ?? defaultDevtoolsDeps;
}

/** The devtools session extras: the Metro/collector deps (real ones unless a test injects) and this owner's leased ports. */
export function extrasFor(ctx: CommandContext, deps: UiDeps, device: UiDevice): SessionExtras {
	return {
		devtools: { ...devtoolsDeps(deps), broker: brokerPortFor(ctx.env, device.udid, devtoolsDeps(deps).brokerClient) },
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

const infoOf = (device: UiDevice) => ({ udid: device.udid, platform: device.platform, name: device.name });

/**
 * Runs `run` against the dev session's broker for this device. Undefined = go direct: `--metro` named a Metro, no
 * broker answers, or its socket vanished mid-call.
 */
async function tryBroker<T>(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	opts: MetroOption,
	run: (target: BrokerTarget) => Promise<Result<T, UiError>>
): Promise<Result<T, UiError> | undefined> {
	if (opts.metro !== undefined) return undefined;
	const handle = await brokerFor(ctx.env, device.udid, devtoolsDeps(deps).brokerClient);
	if (handle === undefined) return undefined;
	const done = await run({ env: ctx.env, udid: device.udid, handle });
	return !done.success && brokerGone(done.error) ? undefined : done;
}

function renderValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

type EvalOptionValues = DevtoolsOptionValues & { await?: true };

/** `warden ui eval <expr> [--await]`: run JavaScript in the app and print the value (through the dev session's broker when one runs). */
export function uiEval(ctx: CommandContext, deps: UiDeps, expression: string, opts: EvalOptionValues): Promise<number> {
	return runUi(ctx, deps, "eval", opts, async (device, env) => {
		const via = await tryBroker(ctx, deps, device, opts, (target) =>
			evalExpr(target, { expression, timeoutMs: env.timeoutMs }, devtoolsDeps(deps).brokerClient)
		);
		if (via !== undefined) {
			return via.success
				? resultFactory.ok({
						device: infoOf(device),
						result: { value: via.data.value },
						text: renderValue(via.data.value),
					})
				: via;
		}
		return reply(
			device,
			await evaluate(opSessionFor(ctx, deps, device, env, extrasFor(ctx, deps, device)), {
				expression,
				await: opts.await === true,
				...(opts.metro === undefined ? {} : { metro: opts.metro }),
			})
		);
	});
}

type TreeOptionValues = DevtoolsOptionValues & { all?: true; max?: string; screen?: string };

/** Android reports dp, `warden ui snapshot` speaks px: ask the driver for the scale. */
async function pixelRatioFor(device: UiDevice, env: UiRunEnv): Promise<number> {
	if (device.platform !== "android") return 1;
	const driver = await env.driver();
	if (!driver.success) return 1;
	const snapshot = await driver.data.snapshot();
	return snapshot.success ? snapshot.data.screen.scale : 1;
}

function treeHeader(tree: {
	screen?: string | undefined;
	components: readonly unknown[];
	truncated?: boolean;
}): string {
	const screen = tree.screen === undefined ? "screen unknown" : `screen ${tree.screen}`;
	return `# ${screen} · ${tree.components.length} components${tree.truncated ? " (truncated)" : ""}`;
}

/** The tree from the dev session's broker; undefined = go direct (it has no inactive-screen or per-screen view). */
async function treeViaBroker(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	opts: TreeOptionValues,
	max: number | undefined,
	pixelRatio: number
): Promise<Result<UiSuccess, UiError> | undefined> {
	if (opts.all === true || opts.screen !== undefined) return undefined;
	const via = await tryBroker(ctx, deps, device, opts, (target) =>
		readTree(target, { ...(max === undefined ? {} : { max }), pixelRatio }, devtoolsDeps(deps).brokerClient)
	);
	if (via === undefined || !via.success) return via;
	const { lines, ...components } = via.data;
	return resultFactory.ok({
		device: infoOf(device),
		result: components,
		text: [treeHeader(components), ...lines].join("\n"),
		warnings: components.truncated ? ["more components exist; raise --max"] : [],
	});
}

/** `warden ui tree [--all] [--max n] [--screen name]`: the app's React components with rects. */
export function uiTree(ctx: CommandContext, deps: UiDeps, opts: TreeOptionValues): Promise<number> {
	return runUi(ctx, deps, "tree", opts, async (device, env) => {
		const max = opts.max === undefined ? resultFactory.ok(undefined) : positiveInt("--max", opts.max);
		if (!max.success) return max;
		const via = await treeViaBroker(ctx, deps, device, opts, max.data, await pixelRatioFor(device, env));
		if (via !== undefined) return via;
		return reply(
			device,
			await tree(opSessionFor(ctx, deps, device, env, extrasFor(ctx, deps, device)), {
				all: opts.all === true,
				...(max.data === undefined ? {} : { max: max.data }),
				...(opts.screen === undefined ? {} : { screen: opts.screen }),
				...(opts.metro === undefined ? {} : { metro: opts.metro }),
			})
		);
	});
}

/** `warden ui reload`: reload the app's JS (Fast Refresh does not need it; this restarts the bundle). */
export function uiReload(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
	return runUi(ctx, deps, "reload", opts, async (device, env) => {
		const via = await tryBroker(ctx, deps, device, opts, (target) =>
			reloadApp(target, devtoolsDeps(deps).brokerClient)
		);
		if (via !== undefined) {
			return via.success
				? resultFactory.ok({
						device: infoOf(device),
						result: { action: "reload", method: via.data.method },
						text: `reloaded (${via.data.method})`,
					})
				: via;
		}
		return reply(
			device,
			await reload(
				opSessionFor(ctx, deps, device, env, extrasFor(ctx, deps, device)),
				opts.metro === undefined ? {} : { metro: opts.metro }
			)
		);
	});
}

function readJsonl<T>(path: string): T[] {
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

const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 23);

function consoleLine(line: ConsoleLine): string {
	const mark = line.kind === "note" ? "--" : line.kind === "exception" ? "!!" : line.level;
	return `${clock(line.ts)} ${mark} ${line.text}`;
}

/** The filter flags `logs`, `exceptions` and `network` share. */
type FilterOptionValues = { since?: string; level?: string; grep?: string; limit?: string; status?: string };

type LogsOptionValues = DevtoolsOptionValues & FilterOptionValues & { bodies?: true };

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type Level = (typeof LEVELS)[number];
const SEVERITY: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

type LineFilter = { since?: number; level?: Level; grep?: string; limit: number; kind?: ConsoleLine["kind"] };

/** `--since --level --grep --limit` (or the positional `n`) as a query; a bad value is a usage error. */
function parseLineFilter(
	ctx: CommandContext,
	opts: FilterOptionValues,
	fallbackLimit: number
): Result<LineFilter, WardenError> {
	const since = opts.since === undefined ? resultFactory.ok(undefined) : parseSince(opts.since, ctx.now());
	if (!since.success) return since;
	const limit = opts.limit === undefined ? resultFactory.ok(fallbackLimit) : positiveInt("--limit", opts.limit);
	if (!limit.success) return limit;
	const level = opts.level;
	if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
		return { success: false, error: uiError("usage", `unknown --level ${level}`, { hint: LEVELS.join(" | ") }) };
	}
	return resultFactory.ok({
		limit: limit.data,
		...(since.data === undefined ? {} : { since: since.data }),
		...(level === undefined ? {} : { level: level as Level }),
		...(opts.grep === undefined ? {} : { grep: opts.grep }),
	});
}

/** The collector file's rows through the same filter the broker applies; `total` counts the matches. */
function filterLines(all: ConsoleLine[], f: LineFilter) {
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
function brokerCaptures(device: UiDevice, logDir: string): Result<UiSuccess, UiError> {
	return resultFactory.ok({
		device: infoOf(device),
		result: { action: "logs", state: "collecting", via: "broker", logDir },
		text: `the dev session's broker is already capturing console + network (${logDir})`,
	});
}

/** The `logs` op's params for the words after `logs`; an unknown word is a usage error. */
function logsParams(words: readonly string[], opts: LogsOptionValues): Result<LogsParams, UiError> {
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
	const count = action === undefined ? resultFactory.ok(DEFAULT_TAIL) : positiveInt("n", action);
	if (!count.success) {
		return {
			success: false,
			error: uiError("usage", `unknown logs action "${action}"`, {
				hint: "logs [n] | start | stop | mark <label> | clear",
			}),
		};
	}
	return resultFactory.ok({ action: "tail", count: count.data });
}

type LinesData = { file: string; total: number; lines: ConsoleLine[] };

const linesPayload = (device: UiDevice, data: LinesData): Result<UiSuccess, UiError> =>
	resultFactory.ok({
		device: infoOf(device),
		result: { file: data.file, total: data.total, lines: data.lines },
		text: data.lines.map(consoleLine).join("\n"),
	});

/** The collector's console file through `filter`. */
function linesFromFile(
	ctx: CommandContext,
	device: UiDevice,
	filter: LineFilter,
	keep: (line: ConsoleLine) => boolean = () => true
): Result<UiSuccess, UiError> {
	const file = join(uiDir(ctx, device.udid), CONSOLE_FILE);
	if (!existsSync(file)) {
		return { success: false, error: uiError("usage", "no console log yet", { hint: COLLECT_HINT }) };
	}
	const { total, lines } = filterLines(readJsonl<ConsoleLine>(file).filter(keep), filter);
	return linesPayload(device, { file, total, lines });
}

const hasLineFilter = (opts: FilterOptionValues): boolean =>
	opts.since !== undefined || opts.level !== undefined || opts.grep !== undefined || opts.limit !== undefined;

/** `warden ui logs [n]`: the last `n` console lines, filtered; the broker answers when a dev session runs. */
async function logsTail(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	action: string | undefined,
	opts: LogsOptionValues
): Promise<Result<UiSuccess, UiError> | undefined> {
	const count = action === undefined ? resultFactory.ok(DEFAULT_TAIL) : positiveInt("n", action);
	if (!count.success) return undefined;
	const filter = parseLineFilter(ctx, opts, count.data);
	if (!filter.success) return filter;
	const { limit, ...query } = filter.data;
	const via = await tryBroker(ctx, deps, device, opts, (target) =>
		queryConsole(target, { ...query, limit }, devtoolsDeps(deps).brokerClient)
	);
	if (via !== undefined) return via.success ? linesPayload(device, via.data) : via;
	return hasLineFilter(opts) ? linesFromFile(ctx, device, filter.data) : undefined;
}

/**
 * `warden ui logs [n] | start [--bodies] | stop | mark <label> | clear`. `start` runs a detached collector
 * (`warden ui-collect`) unless a dev session's broker already captures everything; reads go through the broker when
 * one runs, else the collector's files.
 */
export function uiLogs(ctx: CommandContext, deps: UiDeps, words: string[], opts: LogsOptionValues): Promise<number> {
	return runUi(ctx, deps, "logs", opts, async (device, env) => {
		const [action] = words;
		if (action === "start" && opts.metro === undefined) {
			const broker = await brokerFor(ctx.env, device.udid, devtoolsDeps(deps).brokerClient);
			if (broker !== undefined) return brokerCaptures(device, broker.session.logDir);
		}
		if (action === undefined || /^\d+$/.test(action)) {
			const tailed = await logsTail(ctx, deps, device, action, opts);
			if (tailed !== undefined) return tailed;
		}
		const params = logsParams(words, opts);
		if (!params.success) return params;
		return reply(device, await logs(opSessionFor(ctx, deps, device, env, extrasFor(ctx, deps, device)), params.data));
	});
}

type ExceptionsOptionValues = UiOptionValues & Pick<FilterOptionValues, "since" | "limit">;

/** `warden ui exceptions [--since] [--limit]`: the app's uncaught exceptions (broker, else the collector's file). */
export function uiExceptions(ctx: CommandContext, deps: UiDeps, opts: ExceptionsOptionValues): Promise<number> {
	return runUi(ctx, deps, "exceptions", opts, async (device) => {
		const filter = parseLineFilter(ctx, opts, DEFAULT_TAIL);
		if (!filter.success) return filter;
		const { limit, since } = filter.data;
		const via = await tryBroker(ctx, deps, device, {}, (target) =>
			queryExceptions(target, { limit, ...(since === undefined ? {} : { since }) }, devtoolsDeps(deps).brokerClient)
		);
		if (via !== undefined) return via.success ? linesPayload(device, via.data) : via;
		const { isAppException } = await import("../dev-broker/exceptions");
		return linesFromFile(ctx, device, filter.data, isAppException);
	});
}

/** `warden ui route`: the route key of the screen the app is on (broker, else a direct connection). */
export function uiRoute(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
	return runUi(ctx, deps, "route", opts, async (device, env) => {
		const routePayload = (route: string | null): Result<UiSuccess, UiError> =>
			resultFactory.ok({ device: infoOf(device), result: { route }, text: route ?? "(none)" });
		const via = await tryBroker(ctx, deps, device, opts, (target) =>
			readRouteViaBroker(target, devtoolsDeps(deps).brokerClient)
		);
		if (via !== undefined) return via.success ? routePayload(via.data.route) : via;
		const session = opSessionFor(ctx, deps, device, env, extrasFor(ctx, deps, device));
		const read = await withFacet(session, opts, async (facet) => {
			const found = await routeReader.read(facet);
			return found.success
				? resultFactory.ok(found.data ?? null)
				: { success: false, error: devtoolsError(found.error) };
		});
		return read.success ? routePayload(read.data) : read;
	});
}

/** `warden ui devtools status`: the dev session's broker (attached, yielded to DevTools, lost, ...). */
export function uiDevtoolsStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "devtools status", opts, async (device) => {
		const status = await devtoolsStatus({ env: ctx.env, udid: device.udid }, devtoolsDeps(deps).brokerClient);
		if (!status.success) return status;
		const { state, console: lines, network: net, session } = status.data;
		const where = state.phase === "attached" ? ` (${state.deviceName})` : "";
		const why = state.phase === "yielded" ? `: ${state.reason}` : state.phase === "lost" ? `: ${state.error}` : "";
		return resultFactory.ok({
			device: infoOf(device),
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
export function uiDevtoolsResume(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "devtools resume", opts, async (device) => {
		const resumed = await devtoolsResume({ env: ctx.env, udid: device.udid }, devtoolsDeps(deps).brokerClient);
		if (!resumed.success) return resumed;
		return resultFactory.ok({
			device: infoOf(device),
			result: { action: "resume", state: resumed.data.state },
			text: `broker ${resumed.data.state.phase}`,
		});
	});
}

type NetworkOptionValues = UiOptionValues & FilterOptionValues & { include?: string; id?: string };

type NetworkFilter = { since?: number; urlGrep?: string; status?: number | string; limit: number };

/** `--since --grep --status --limit` (or the positional `n`) for the network log. */
function parseNetworkFilter(
	ctx: CommandContext,
	opts: FilterOptionValues,
	fallbackLimit: number
): Result<NetworkFilter, WardenError> {
	const base = parseLineFilter(ctx, { ...opts, level: undefined }, fallbackLimit);
	if (!base.success) return base;
	const raw = opts.status;
	if (raw !== undefined && !/^([1-5]xx|\d{3})$/.test(raw)) {
		return { success: false, error: uiError("usage", `--status must be a code (404) or a class (4xx), got "${raw}"`) };
	}
	return resultFactory.ok({
		limit: base.data.limit,
		...(base.data.since === undefined ? {} : { since: base.data.since }),
		...(base.data.grep === undefined ? {} : { urlGrep: base.data.grep }),
		...(raw === undefined ? {} : { status: /^\d{3}$/.test(raw) ? Number(raw) : raw }),
	});
}

/** The broker's `network.query` filter applied to a collector row. */
function networkMatches(entry: NetworkEntry, f: NetworkFilter): boolean {
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

function networkLine(entry: NetworkEntry): string {
	const status = entry.status === 0 ? "ERR" : String(entry.status);
	return `#${entry.id} ${entry.method} ${entry.url} ${status} ${entry.durationMs}ms${entry.error ? ` ${entry.error}` : ""}`;
}

function headerLines(label: string, headers: Record<string, string>): string[] {
	return Object.entries(headers).map(([name, value]) => `    ${label} ${name}: ${value}`);
}

function networkDetail(entry: NetworkEntry, include: ReadonlySet<string>): string {
	const lines = [networkLine(entry)];
	if (include.has("headers")) {
		lines.push(...headerLines(">", entry.requestHeaders), ...headerLines("<", entry.responseHeaders));
	}
	if (include.has("body")) {
		if (entry.requestBody !== undefined) lines.push(`    > body ${entry.requestBody}`);
		if (entry.responseBody !== undefined) {
			lines.push(`    < body ${entry.responseBody}${entry.responseBodyTruncated ? " (truncated)" : ""}`);
		}
	}
	return lines.join("\n");
}

function networkPayload(
	device: UiDevice,
	data: { file: string; total: number; entries: NetworkEntry[] },
	include: ReadonlySet<string>
): Result<UiSuccess, UiError> {
	return resultFactory.ok({
		device: infoOf(device),
		result: { file: data.file, total: data.total, entries: data.entries },
		text: data.entries.map((entry) => networkDetail(entry, include)).join("\n"),
	});
}

/** `warden ui network --id <id>`: one entry with headers and bodies. */
function networkEntry(device: UiDevice, entry: NetworkEntry | undefined, id: number): Result<UiSuccess, UiError> {
	if (!entry) {
		return {
			success: false,
			error: uiError("target_not_found", `no network entry #${id}`, { hint: "`warden ui network` lists ids" }),
		};
	}
	return resultFactory.ok({
		device: infoOf(device),
		result: { entry },
		text: networkDetail(entry, new Set(NETWORK_INCLUDES)),
	});
}

/** `network` from the dev session's broker; undefined = read the collector's file. */
async function networkViaBroker(
	deps: UiDeps,
	device: UiDevice,
	ctx: CommandContext,
	id: number | undefined,
	filter: NetworkFilter,
	include: ReadonlySet<string>
): Promise<Result<UiSuccess, UiError> | undefined> {
	const brokerDeps = devtoolsDeps(deps).brokerClient;
	if (id !== undefined) {
		const via = await tryBroker(ctx, deps, device, {}, (target) => networkEntryById(target, id, brokerDeps));
		return via === undefined ? undefined : via.success ? networkEntry(device, via.data, id) : via;
	}
	const { limit, since, urlGrep, status } = filter;
	const query = {
		limit,
		...(since === undefined ? {} : { since }),
		...(urlGrep === undefined ? {} : { urlGrep }),
		...(status === undefined ? {} : { status }),
	};
	const via = await tryBroker(ctx, deps, device, {}, (target) => queryNetwork(target, query, brokerDeps));
	return via === undefined ? undefined : via.success ? networkPayload(device, via.data, include) : via;
}

const hasNetworkFilter = (opts: FilterOptionValues): boolean =>
	opts.since !== undefined || opts.grep !== undefined || opts.status !== undefined || opts.limit !== undefined;

/** `warden ui network [n] [--include headers,body] [--id <id>] [--since --grep --status --limit]`: the app's `fetch` calls (broker, else the collector's file). */
export function uiNetwork(
	ctx: CommandContext,
	deps: UiDeps,
	countArg: string | undefined,
	opts: NetworkOptionValues
): Promise<number> {
	return runUi(ctx, deps, "network", opts, async (device, env) => {
		const includeParts = (opts.include ?? "").split(",").filter((part) => part !== "");
		const unknown = includeParts.filter((part) => !(NETWORK_INCLUDES as readonly string[]).includes(part));
		if (unknown.length > 0) {
			return {
				success: false,
				error: uiError("usage", `unknown --include ${unknown.join(",")}`, { hint: "headers,body" }),
			};
		}
		const count = countArg === undefined ? resultFactory.ok(DEFAULT_TAIL) : positiveInt("n", countArg);
		if (!count.success) return count;
		const id = opts.id === undefined ? resultFactory.ok(undefined) : positiveInt("--id", opts.id);
		if (!id.success) return id;
		const filter = parseNetworkFilter(ctx, opts, count.data);
		if (!filter.success) return filter;
		const include = new Set(includeParts);
		const via = await networkViaBroker(deps, device, ctx, id.data, filter.data, include);
		if (via !== undefined) return via;
		if (id.data === undefined && hasNetworkFilter(opts)) {
			const file = join(uiDir(ctx, device.udid), NETWORK_FILE);
			if (!existsSync(file)) {
				return { success: false, error: uiError("usage", "no network log yet", { hint: COLLECT_HINT }) };
			}
			const matched = readJsonl<NetworkEntry>(file).filter((entry) => networkMatches(entry, filter.data));
			return networkPayload(
				device,
				{ file, total: matched.length, entries: matched.slice(-filter.data.limit) },
				include
			);
		}
		return reply(
			device,
			await network(opSessionFor(ctx, deps, device, env), {
				count: count.data,
				include: includeParts as NetworkInclude[],
				...(id.data === undefined ? {} : { id: id.data }),
			})
		);
	});
}
