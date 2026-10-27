import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { sameOwner } from "@delacour/warden-core/types";
import type {
	ConsoleLine,
	DevtoolsError,
	DevtoolsFacet,
	DevtoolsResult,
	NetworkEntry,
} from "@delacour/warden-e2e/devtools/devtools.types";
import { type OpenDevtoolsFacetOptions, openDevtoolsFacet } from "@delacour/warden-e2e/devtools/facet";
import { findMetro, type MetroProbe } from "@delacour/warden-e2e/devtools/metro";
import { readRoute } from "@delacour/warden-e2e/devtools/route";
import { formatTree } from "@delacour/warden-e2e/devtools/tree";
import { ok, type Result } from "@delacour/warden-types/result";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { metroOwner } from "../metro";
import {
	type BrokerClientDeps,
	type BrokerTarget,
	brokerFor,
	brokerGone,
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
import { DEFAULT_TAIL } from "./devtools-register";
import type { UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { uiDir } from "./paths";
import { mayBeRecorded, type ProcessCommand, processCommand, recordedIdentity } from "./process-identity";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { positiveInt } from "./snapshot-command";
import { readState, type UiState, updateState } from "./state";

const START_HINT = "start the dev client with `warden ui open <bundle> --metro <url>`";
const COLLECT_HINT = "run `warden ui logs start` first";

export const CONSOLE_FILE = "console.jsonl";
export const NETWORK_FILE = "network.jsonl";
const COLLECTOR_LOG = "collector.log";

/** Everything impure about the devtools subcommands; tests replace it. */
export type DevtoolsDeps = {
	/** attach to the dev client (default: `openDevtoolsFacet` over the global `fetch` / `WebSocket`) */
	open: (options: OpenDevtoolsFacetOptions) => Promise<DevtoolsResult<DevtoolsFacet>>;
	/** who serves a leased port: `ours` (this checkout's Metro), `foreign`, or `none` */
	probe: (ctx: CommandContext, port: number) => Promise<MetroProbe>;
	/** how a live `warden dev` session's broker is found and called (default: the registry and the real socket) */
	broker?: BrokerClientDeps;
	collector: {
		/** the argv that re-runs this warden (`[...self, "ui-collect", …]`) */
		self: () => string[];
		/** start the collector detached from this process (survives our exit) */
		spawnDetached: (spec: { cmd: string[]; logPath: string }) => { pid: number };
		kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
		pidAlive: PidAlive;
		/** a pid's command line (`ps`): the recorded pid is signalled only while it is still this device's collector. Absent: liveness alone */
		command?: ProcessCommand;
	};
};

export const defaultDevtoolsDeps: DevtoolsDeps = {
	open: (options) => openDevtoolsFacet(options),
	probe: async (ctx, port) => {
		const owner = await metroOwner(ctx.exec, port, ctx.cwd);
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
		pidAlive: processAlive,
		command: processCommand,
	},
};

type CollectorRecord = NonNullable<UiState["collector"]>;

/**
 * What the collector's command line carries (`ui-collect --out <device dir>`): tells it from a reused pid. The dir is
 * the one recorded at start (a record from an older warden has none: today's spelling of it).
 */
const collectorMarks = (ctx: CommandContext, udid: string, record: CollectorRecord): string[] => [
	"ui-collect",
	`--out ${record.out ?? uiDir(ctx, udid)}`,
];

type MetroOption = { metro?: string };
type DevtoolsOptionValues = UiOptionValues & MetroOption;

/** A devtools failure as a `warden ui` error: no dev client (exit 3) or a plain failure (exit 1). */
export function devtoolsUiError(error: DevtoolsError): UiError {
	const unreachable = error.code === "devtools_unavailable" || error.code === "device_mismatch";
	return unreachable
		? uiError("devtools_unavailable", error.message, { hint: START_HINT, details: { devtools: error.code } })
		: uiError("failed", `${error.code}: ${error.message}`, { details: { devtools: error.code } });
}

/** Which Metro serves this device: `--metro`, `WARDEN_METRO_URL`, `state.json`, then the owner's leased ports. */
async function metroFor(
	ctx: CommandContext,
	deps: DevtoolsDeps,
	device: UiDevice,
	flag: string | undefined
): Promise<Result<string, UiError>> {
	const portLeases = ctx
		.store()
		.listLeases()
		.flatMap((lease) =>
			lease.resource.kind === "port" && sameOwner(lease.owner, device.lease.owner) ? [lease.resource.port] : []
		);
	const found = await findMetro({
		...(flag === undefined ? {} : { flag }),
		...(ctx.env.WARDEN_METRO_URL === undefined ? {} : { env: ctx.env.WARDEN_METRO_URL }),
		...(readState(ctx, device.udid).metroUrl === undefined
			? {}
			: { stateMetroUrl: readState(ctx, device.udid).metroUrl }),
		portLeases,
		probe: (port) => deps.probe(ctx, port),
	});
	if (found) return ok(found.url);
	return {
		success: false,
		error: uiError(
			"devtools_unavailable",
			"no Metro found for this device: a release build, or the dev client was never pointed at one",
			{ hint: START_HINT }
		),
	};
}

/** Attach to the device's dev client, run `fn`, close the facet. */
export async function withFacet<T>(
	ctx: CommandContext,
	deps: DevtoolsDeps,
	device: UiDevice,
	env: UiRunEnv,
	opts: MetroOption,
	fn: (facet: DevtoolsFacet) => Promise<Result<T, UiError>>
): Promise<Result<T, UiError>> {
	const metro = await metroFor(ctx, deps, device, opts.metro);
	if (!metro.success) return metro;
	const app = readState(ctx, device.udid).app;
	const opened = await deps.open({
		env: { metroUrl: metro.data },
		device: {
			...(app === undefined ? {} : { appId: app }),
			...(device.platform === "ios" && device.name ? { deviceName: device.name } : {}),
		},
		fetch,
		WebSocket,
		timeoutMs: env.timeoutMs,
	});
	if (!opened.success) return { success: false, error: devtoolsUiError(opened.error) };
	try {
		return await fn(opened.data);
	} finally {
		opened.data.close();
	}
}

export function devtoolsDeps(deps: UiDeps): DevtoolsDeps {
	return deps.devtools ?? defaultDevtoolsDeps;
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
	const handle = await brokerFor(ctx.env, device.udid, devtoolsDeps(deps).broker);
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

/** `warden ui eval <expr> [--await]`: run JavaScript in the app and print the value. */
export function uiEval(ctx: CommandContext, deps: UiDeps, expression: string, opts: EvalOptionValues): Promise<number> {
	return runUi(ctx, deps, "eval", opts, async (device, env) => {
		const via = await tryBroker(ctx, deps, device, opts, (target) =>
			evalExpr(target, { expression, timeoutMs: env.timeoutMs }, devtoolsDeps(deps).broker)
		);
		if (via !== undefined) {
			return via.success
				? ok({ device: infoOf(device), result: { value: via.data.value }, text: renderValue(via.data.value) })
				: via;
		}
		return withFacet(ctx, devtoolsDeps(deps), device, env, opts, async (facet) => {
			const evaluated = await facet.evaluate(expression, { await: opts.await === true, timeoutMs: env.timeoutMs });
			if (!evaluated.success) {
				const { message, code, exceptionDetails } = evaluated.error;
				if (code === "devtools_unavailable" || code === "device_mismatch") {
					return { success: false, error: devtoolsUiError({ code, message }) };
				}
				return {
					success: false,
					error: uiError("failed", message, exceptionDetails ? { details: { exception: exceptionDetails } } : {}),
				};
			}
			return ok({
				device: infoOf(device),
				result: { value: evaluated.data ?? null },
				text: renderValue(evaluated.data),
			});
		});
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

/** The tree from the dev session's broker; undefined = go direct (it has no inactive-screen or per-screen view). */
async function treeViaBroker(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	opts: TreeOptionValues,
	max: number | undefined,
	pixelRatio: number
): Promise<Result<UiPayload, UiError> | undefined> {
	if (opts.all === true || opts.screen !== undefined) return undefined;
	const via = await tryBroker(ctx, deps, device, opts, (target) =>
		readTree(target, { ...(max === undefined ? {} : { max }), pixelRatio }, devtoolsDeps(deps).broker)
	);
	if (via === undefined || !via.success) return via;
	const { lines, ...tree } = via.data;
	return ok({
		device: infoOf(device),
		result: tree,
		text: [treeHeader(tree), ...lines].join("\n"),
		warnings: tree.truncated ? ["more components exist; raise --max"] : [],
	});
}

/** `warden ui tree [--all] [--max n] [--screen name]`: the app's React components with rects. */
export function uiTree(ctx: CommandContext, deps: UiDeps, opts: TreeOptionValues): Promise<number> {
	return runUi(ctx, deps, "tree", opts, async (device, env) => {
		const max = opts.max === undefined ? ok(undefined) : positiveInt("--max", opts.max);
		if (!max.success) return max;
		const pixelRatio = await pixelRatioFor(device, env);
		const via = await treeViaBroker(ctx, deps, device, opts, max.data, pixelRatio);
		if (via !== undefined) return via;
		return withFacet(ctx, devtoolsDeps(deps), device, env, opts, (facet) =>
			fetchTree(facet, device, opts, max.data, pixelRatio)
		);
	});
}

/** What a `warden ui` subcommand hands back on success. */
type UiPayload = { device: ReturnType<typeof infoOf>; result: unknown; text: string; warnings?: string[] };

type ComponentTree = Extract<Awaited<ReturnType<DevtoolsFacet["tree"]>>, { success: true }>["data"];

/** The `# screen … · n components` line above a `warden ui tree` listing. */
function treeHeader(tree: ComponentTree): string {
	const screen = tree.screen === undefined ? "screen unknown" : `screen ${tree.screen}`;
	return `# ${screen} · ${tree.components.length} components${tree.truncated ? " (truncated)" : ""}`;
}

/** Fetch the component tree from the facet and shape it as a `warden ui tree` payload. */
async function fetchTree(
	facet: DevtoolsFacet,
	device: UiDevice,
	opts: TreeOptionValues,
	max: number | undefined,
	pixelRatio: number
): Promise<Result<UiPayload, UiError>> {
	const fetched = await facet.tree({
		all: opts.all === true,
		...(max === undefined ? {} : { max }),
		...(opts.screen === undefined ? {} : { screen: opts.screen }),
		pixelRatio,
	});
	if (!fetched.success) return { success: false, error: devtoolsUiError(fetched.error) };
	const tree = fetched.data;
	return ok({
		device: infoOf(device),
		result: tree,
		text: [treeHeader(tree), ...formatTree(tree, { all: opts.all === true })].join("\n"),
		warnings: tree.truncated ? ["more components exist; raise --max"] : [],
	});
}

/** `warden ui reload`: reload the app's JS (Fast Refresh does not need it; this restarts the bundle). */
export function uiReload(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
	return runUi(ctx, deps, "reload", opts, async (device, env) => {
		const via = await tryBroker(ctx, deps, device, opts, (target) => reloadApp(target, devtoolsDeps(deps).broker));
		if (via !== undefined) {
			return via.success
				? ok({
						device: infoOf(device),
						result: { action: "reload", method: via.data.method },
						text: `reloaded (${via.data.method})`,
					})
				: via;
		}
		return withFacet(ctx, devtoolsDeps(deps), device, env, opts, async (facet) => {
			const reloaded = await facet.reloadJs();
			if (!reloaded.success) return { success: false, error: devtoolsUiError(reloaded.error) };
			return ok({
				device: infoOf(device),
				result: { action: "reload", method: reloaded.data.method },
				text: `reloaded (${reloaded.data.method})`,
			});
		});
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
): Result<LineFilter, UiError> {
	const since = opts.since === undefined ? ok(undefined) : parseSince(opts.since, ctx.now());
	if (!since.success) return since;
	const limit = opts.limit === undefined ? ok(fallbackLimit) : positiveInt("--limit", opts.limit);
	if (!limit.success) return limit;
	const level = opts.level;
	if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
		return { success: false, error: uiError("usage", `unknown --level ${level}`, { hint: LEVELS.join(" | ") }) };
	}
	return ok({
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
function brokerCaptures(device: UiDevice, logDir: string): Result<UiPayload, UiError> {
	return ok({
		device: infoOf(device),
		result: { action: "logs", state: "collecting", via: "broker", logDir },
		text: `the dev session's broker is already capturing console + network (${logDir})`,
	});
}

async function startCollector(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	opts: LogsOptionValues
): Promise<Result<{ device: ReturnType<typeof infoOf>; result: unknown; text: string; warnings?: string[] }, UiError>> {
	const d = devtoolsDeps(deps);
	if (opts.metro === undefined) {
		const broker = await brokerFor(ctx.env, device.udid, d.broker);
		if (broker !== undefined) return brokerCaptures(device, broker.session.logDir);
	}
	const state = readState(ctx, device.udid);
	if (
		state.collector &&
		mayBeRecorded(d.collector, state.collector.pid, collectorMarks(ctx, device.udid, state.collector))
	) {
		return ok({
			device: infoOf(device),
			result: { action: "logs", state: "collecting", pid: state.collector.pid, already: true },
			text: `already collecting (pid ${state.collector.pid})`,
		});
	}
	const metro = await metroFor(ctx, d, device, opts.metro);
	if (!metro.success) return metro;
	const out = uiDir(ctx, device.udid);
	mkdirSync(out, { recursive: true });
	const cmd = [
		...d.collector.self(),
		"ui-collect",
		"--metro",
		metro.data,
		"--out",
		out,
		...(state.app === undefined ? [] : ["--app-id", state.app]),
		...(device.platform === "ios" && device.name ? ["--device-name", device.name] : []),
		...(opts.bodies === true ? ["--include-bodies"] : []),
	];
	const { pid } = d.collector.spawnDetached({ cmd, logPath: join(out, COLLECTOR_LOG) });
	updateState(ctx, device.udid, (current) => ({ ...current, collector: { pid, startedAt: ctx.now(), out } }));
	return ok({
		device: infoOf(device),
		result: { action: "logs", state: "collecting", pid, metroUrl: metro.data, out },
		text: `collecting console + network to ${out} (pid ${pid}); stops after 60 s without activity`,
	});
}

function stopCollector(ctx: CommandContext, deps: UiDeps, device: UiDevice) {
	const d = devtoolsDeps(deps);
	const state = readState(ctx, device.udid);
	const running = state.collector;
	if (!running) {
		return { success: false as const, error: uiError("usage", "not collecting", { hint: COLLECT_HINT }) };
	}
	const identity = recordedIdentity(d.collector, running.pid, collectorMarks(ctx, device.udid, running));
	if (identity === "unknown") {
		// alive but its command line unreadable: it may still be the collector, so it is neither signalled nor forgotten
		return ok({
			device: infoOf(device),
			result: { action: "logs", state: "collecting", pid: running.pid },
			text: `collector (pid ${running.pid}) left running`,
			warnings: [`could not stop the collector (pid ${running.pid}): its command line could not be read`],
		});
	}
	if (identity === "match") d.collector.kill(running.pid, "SIGTERM");
	updateState(ctx, device.udid, (current) => {
		if (current.collector?.pid !== running.pid) return current;
		const { collector: _stopped, ...rest } = current;
		return rest;
	});
	return ok({
		device: infoOf(device),
		result: { action: "logs", state: "stopped", pid: running.pid },
		text: `stopped collector (pid ${running.pid})`,
	});
}

/**
 * `warden ui logs [n] | start [--bodies] | stop | mark <label> | clear`. `start` runs a detached collector
 * (`warden ui-collect`) that appends the app's console and network to `$WARDEN_HOME/ui/<udid>/{console,network}.jsonl`;
 * the other forms read or edit those files, so they work after the collector has ended too.
 */
export function uiLogs(ctx: CommandContext, deps: UiDeps, words: string[], opts: LogsOptionValues): Promise<number> {
	return runUi(ctx, deps, "logs", opts, async (device) => {
		const [action, ...rest] = words;
		if (action === "start") return startCollector(ctx, deps, device, opts);
		if (action === "stop") return stopCollector(ctx, deps, device);
		if (action === "mark") return logsMark(ctx, device, rest.join(" ").trim());
		if (action === "clear") return logsClear(ctx, device);
		return logsTail(ctx, deps, device, action, opts);
	});
}

/** `warden ui logs mark <label>`: append a note line to the console log. */
function logsMark(ctx: CommandContext, device: UiDevice, label: string): Result<UiPayload, UiError> {
	if (label === "") return { success: false, error: uiError("usage", "logs mark needs a label") };
	const line: ConsoleLine = { ts: ctx.now(), level: "info", kind: "note", text: label };
	mkdirSync(uiDir(ctx, device.udid), { recursive: true });
	appendFileSync(join(uiDir(ctx, device.udid), CONSOLE_FILE), `${JSON.stringify(line)}\n`);
	return ok({ device: infoOf(device), result: { action: "logs", mark: label }, text: `marked "${label}"` });
}

/** `warden ui logs clear`: truncate whichever of the console and network logs exist. */
function logsClear(ctx: CommandContext, device: UiDevice): Result<UiPayload, UiError> {
	for (const name of [CONSOLE_FILE, NETWORK_FILE]) {
		const path = join(uiDir(ctx, device.udid), name);
		if (existsSync(path)) writeFileSync(path, "");
	}
	return ok({
		device: infoOf(device),
		result: { action: "logs", cleared: true },
		text: "cleared console and network logs",
	});
}

/** `warden ui logs [n]`: the last `n` console lines; any other word is an unknown action. */
async function logsTail(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	action: string | undefined,
	opts: LogsOptionValues
): Promise<Result<UiPayload, UiError>> {
	const count = action === undefined ? ok(DEFAULT_TAIL) : positiveInt("n", action);
	if (!count.success) {
		return {
			success: false,
			error: uiError("usage", `unknown logs action "${action}"`, {
				hint: "logs [n] | start | stop | mark <label> | clear",
			}),
		};
	}
	const filter = parseLineFilter(ctx, opts, count.data);
	if (!filter.success) return filter;
	const { limit, ...query } = filter.data;
	const via = await tryBroker(ctx, deps, device, opts, (target) =>
		queryConsole(target, { ...query, limit }, devtoolsDeps(deps).broker)
	);
	if (via !== undefined) return via.success ? linesPayload(device, via.data) : via;
	return linesFromFile(ctx, device, filter.data);
}

type LinesData = { file: string; total: number; lines: ConsoleLine[] };

const linesPayload = (device: UiDevice, data: LinesData): Result<UiPayload, UiError> =>
	ok({
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
): Result<UiPayload, UiError> {
	const file = join(uiDir(ctx, device.udid), CONSOLE_FILE);
	if (!existsSync(file)) {
		return { success: false, error: uiError("usage", "no console log yet", { hint: COLLECT_HINT }) };
	}
	const { total, lines } = filterLines(readJsonl<ConsoleLine>(file).filter(keep), filter);
	return linesPayload(device, { file, total, lines });
}

type ExceptionsOptionValues = UiOptionValues & Pick<FilterOptionValues, "since" | "limit">;

/** `warden ui exceptions [--since] [--limit]`: the app's uncaught exceptions (broker, else the collector's file). */
export function uiExceptions(ctx: CommandContext, deps: UiDeps, opts: ExceptionsOptionValues): Promise<number> {
	return runUi(ctx, deps, "exceptions", opts, async (device) => {
		const filter = parseLineFilter(ctx, opts, DEFAULT_TAIL);
		if (!filter.success) return filter;
		const { limit, since } = filter.data;
		const via = await tryBroker(ctx, deps, device, {}, (target) =>
			queryExceptions(target, { limit, ...(since === undefined ? {} : { since }) }, devtoolsDeps(deps).broker)
		);
		if (via !== undefined) return via.success ? linesPayload(device, via.data) : via;
		const { isAppException } = await import("../dev-broker/exceptions");
		return linesFromFile(ctx, device, filter.data, isAppException);
	});
}

/** `warden ui route`: the route key of the screen the app is on (broker, else a direct connection). */
export function uiRoute(ctx: CommandContext, deps: UiDeps, opts: DevtoolsOptionValues): Promise<number> {
	return runUi(ctx, deps, "route", opts, async (device, env) => {
		const routePayload = (route: string | null): Result<UiPayload, UiError> =>
			ok({ device: infoOf(device), result: { route }, text: route ?? "(none)" });
		const via = await tryBroker(ctx, deps, device, opts, (target) =>
			readRouteViaBroker(target, devtoolsDeps(deps).broker)
		);
		if (via !== undefined) return via.success ? routePayload(via.data.route) : via;
		return withFacet(ctx, devtoolsDeps(deps), device, env, opts, async (facet) => {
			const read = await readRoute(facet);
			return read.success ? routePayload(read.data ?? null) : { success: false, error: devtoolsUiError(read.error) };
		});
	});
}

/** `warden ui devtools status`: the dev session's broker (attached, yielded to DevTools, lost, ...). */
export function uiDevtoolsStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "devtools status", opts, async (device) => {
		const status = await devtoolsStatus({ env: ctx.env, udid: device.udid }, devtoolsDeps(deps).broker);
		if (!status.success) return status;
		const { state, console: lines, network, session } = status.data;
		const where = state.phase === "attached" ? ` (${state.deviceName})` : "";
		const why = state.phase === "yielded" ? `: ${state.reason}` : state.phase === "lost" ? `: ${state.error}` : "";
		return ok({
			device: infoOf(device),
			result: status.data,
			text: [
				`broker ${state.phase}${where}${why}`,
				`metro ${session.metroUrl} · pid ${status.data.pid}`,
				`console ${lines.buffered} buffered / ${lines.total} total · network ${network.buffered} / ${network.total}`,
				`methods ${status.data.methods.join(", ")}`,
			].join("\n"),
		});
	});
}

/** `warden ui devtools resume`: take the page back after the broker yielded to Chrome DevTools. */
export function uiDevtoolsResume(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "devtools resume", opts, async (device) => {
		const resumed = await devtoolsResume({ env: ctx.env, udid: device.udid }, devtoolsDeps(deps).broker);
		if (!resumed.success) return resumed;
		return ok({
			device: infoOf(device),
			result: { action: "resume", state: resumed.data.state },
			text: `broker ${resumed.data.state.phase}`,
		});
	});
}

type NetworkOptionValues = UiOptionValues & FilterOptionValues & { include?: string; id?: string };

const INCLUDES = ["headers", "body"] as const;

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

type NetworkArgs = { include: Set<string>; id: number | undefined; filter: NetworkFilter };

/** `network`'s `[n]`, `--include`, `--id` and filter flags, or the first usage error. */
function parseNetworkArgs(
	ctx: CommandContext,
	countArg: string | undefined,
	opts: NetworkOptionValues
): Result<NetworkArgs, UiError> {
	const include = parseInclude(opts.include);
	if (!include.success) return include;
	const count = countArg === undefined ? ok(DEFAULT_TAIL) : positiveInt("n", countArg);
	if (!count.success) return count;
	const id = opts.id === undefined ? ok(undefined) : positiveInt("--id", opts.id);
	if (!id.success) return id;
	const filter = parseNetworkFilter(ctx, opts, count.data);
	return filter.success ? ok({ include: include.data, id: id.data, filter: filter.data }) : filter;
}

/** `network` from the dev session's broker; undefined = read the collector's file. */
async function networkViaBroker(
	deps: UiDeps,
	device: UiDevice,
	ctx: CommandContext,
	id: number | undefined,
	filter: NetworkFilter,
	include: ReadonlySet<string>
): Promise<Result<UiPayload, UiError> | undefined> {
	const brokerDeps = devtoolsDeps(deps).broker;
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

/** `warden ui network [n] [--include headers,body] [--id <id>]`: what the collector recorded of the app's `fetch` calls. */
export function uiNetwork(
	ctx: CommandContext,
	deps: UiDeps,
	countArg: string | undefined,
	opts: NetworkOptionValues
): Promise<number> {
	return runUi(ctx, deps, "network", opts, async (device) => {
		const args = parseNetworkArgs(ctx, countArg, opts);
		if (!args.success) return args;
		const { include, id, filter } = args.data;
		const via = await networkViaBroker(deps, device, ctx, id, filter, include);
		if (via !== undefined) return via;
		const file = join(uiDir(ctx, device.udid), NETWORK_FILE);
		if (!existsSync(file)) {
			return { success: false, error: uiError("usage", "no network log yet", { hint: COLLECT_HINT }) };
		}
		const all = readJsonl<NetworkEntry>(file);
		if (id !== undefined)
			return networkEntry(
				device,
				all.find((entry) => entry.id === id),
				id
			);
		const matched = all.filter((entry) => networkMatches(entry, filter));
		return networkPayload(device, { file, total: matched.length, entries: matched.slice(-filter.limit) }, include);
	});
}

/** The `--include` list as a set, or a usage error naming the unknown parts. */
function parseInclude(raw: string | undefined): Result<Set<string>, UiError> {
	const include = new Set((raw ?? "").split(",").filter((part) => part !== ""));
	const unknown = [...include].filter((part) => !(INCLUDES as readonly string[]).includes(part));
	if (unknown.length > 0) {
		return {
			success: false,
			error: uiError("usage", `unknown --include ${unknown.join(",")}`, { hint: "headers,body" }),
		};
	}
	return ok(include);
}

type NetworkFilter = { since?: number; urlGrep?: string; status?: number | string; limit: number };

/** `--since --grep --status --limit` (or the positional `n`) for the network log. */
function parseNetworkFilter(
	ctx: CommandContext,
	opts: FilterOptionValues,
	fallbackLimit: number
): Result<NetworkFilter, UiError> {
	const base = parseLineFilter(ctx, { ...opts, level: undefined }, fallbackLimit);
	if (!base.success) return base;
	const raw = opts.status;
	if (raw !== undefined && !/^([1-5]xx|\d{3})$/.test(raw)) {
		return { success: false, error: uiError("usage", `--status must be a code (404) or a class (4xx), got "${raw}"`) };
	}
	return ok({
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

function networkPayload(
	device: UiDevice,
	data: { file: string; total: number; entries: NetworkEntry[] },
	include: ReadonlySet<string>
): Result<UiPayload, UiError> {
	return ok({
		device: infoOf(device),
		result: { file: data.file, total: data.total, entries: data.entries },
		text: data.entries.map((entry) => networkDetail(entry, include)).join("\n"),
	});
}

/** `warden ui network --id <id>`: one entry with headers and bodies. */
function networkEntry(device: UiDevice, entry: NetworkEntry | undefined, id: number): Result<UiPayload, UiError> {
	if (!entry) {
		return {
			success: false,
			error: uiError("target_not_found", `no network entry #${id}`, { hint: "`warden ui network` lists ids" }),
		};
	}
	return ok({ device: infoOf(device), result: { entry }, text: networkDetail(entry, new Set(INCLUDES)) });
}
