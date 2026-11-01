import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ConsoleLine,
	DevtoolsError,
	DevtoolsFacet,
	DevtoolsResult,
	NetworkEntry,
	ReactTree,
} from "@delacour/warden-devtools/devtools.types";
import type { OpenDevtoolsFacetOptions } from "@delacour/warden-devtools/facet";
import { findMetro, type MetroProbe } from "@delacour/warden-devtools/metro";
import { formatTree } from "@delacour/warden-devtools/tree";
import type { PidAlive } from "@delacour/warden-store/liveness";
import { mayBeRecorded, type ProcessCommand, recordedIdentity } from "@delacour/warden-store/process-identity";
import type { WardenError } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import type {
	BrokerEntries,
	BrokerLines,
	BrokerPort,
	BrokerStateView,
	BrokerStatusView,
	EntryQuery,
	LineQuery,
} from "./broker-port";
import { fail, opError } from "./errors";
import { uiDir } from "./paths";
import type { OpDone, OpHost, OpOutcome, OpSession } from "./session";
import type { DeviceState } from "./state-store";

const START_HINT = "start the dev client with `warden ui open <bundle> --metro <url>`";
const COLLECT_HINT = "run `warden ui logs start` first";

/** Default number of lines `logs` / `network` show. */
export const DEFAULT_TAIL = 50;

export const CONSOLE_FILE = "console.jsonl";
export const NETWORK_FILE = "network.jsonl";
const COLLECTOR_LOG = "collector.log";

/** Everything impure about the devtools ops; tests replace it. */
export type DevtoolsDeps = {
	/** attach to the dev client (default: `openDevtoolsFacet` over the global `fetch` / `WebSocket`) */
	open: (options: OpenDevtoolsFacetOptions) => Promise<DevtoolsResult<DevtoolsFacet>>;
	/** who serves a leased port: `ours` (this checkout's Metro), `foreign`, or `none` */
	probe: (host: OpHost, port: number) => Promise<MetroProbe>;
	/** the `warden dev` session's devtools broker for this device; absent = always go direct to Metro */
	broker?: BrokerPort;
	/** an uncaught app exception (not a plain `console.error`); absent: only `kind: "exception"` lines count */
	isAppException?: (line: ConsoleLine) => boolean;
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

type CollectorRecord = NonNullable<DeviceState["collector"]>;

/**
 * What the collector's command line carries (`ui-collect --out <device dir>`): tells it from a reused pid. The dir is
 * the one recorded at start (a record from an older warden has none: today's spelling of it).
 */
const collectorMarks = (host: OpHost, udid: string, record: CollectorRecord): string[] => [
	"ui-collect",
	`--out ${record.out ?? uiDir(host.home, udid)}`,
];

/** Options every devtools op takes. */
export type MetroParams = { metro?: string };

/** A devtools failure as an op error: no dev client (`devtools_unavailable`) or a plain failure. */
export function devtoolsError(error: DevtoolsError): WardenError {
	const unreachable = error.code === "devtools_unavailable" || error.code === "device_mismatch";
	return unreachable
		? opError("devtools_unavailable", error.message, { hint: START_HINT, details: { devtools: error.code } })
		: opError("failed", `${error.code}: ${error.message}`, { details: { devtools: error.code } });
}

function depsOf(session: OpSession): Result<DevtoolsDeps, WardenError> {
	return session.devtools
		? ok(session.devtools)
		: fail(opError("engine_unavailable", "this session has no devtools deps (Metro access)"));
}

/**
 * Runs `run` against the dev session's broker. Undefined = go direct: `metro` names a Metro, no broker is wired or
 * answers, or its socket vanished mid-call.
 */
async function viaBroker<T>(
	session: OpSession,
	metro: string | undefined,
	run: (broker: BrokerPort) => Promise<Result<T, WardenError> | undefined>
): Promise<Result<T, WardenError> | undefined> {
	const broker = session.devtools?.broker;
	if (broker === undefined || metro !== undefined) return undefined;
	return run(broker);
}

const SINCE_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `since`: a duration back from `now` (`30s`, `5m`, `2h`, `1d`, `250ms`) or an ISO time, as epoch ms. */
export function parseSince(raw: string, now: number): Result<number, WardenError> {
	const duration = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
	if (duration !== null) return ok(now - Number(duration[1]) * (SINCE_UNITS[duration[2] ?? "ms"] ?? 1));
	const at = Date.parse(raw);
	if (Number.isNaN(at)) {
		return fail(opError("usage", `--since must be a duration (30s, 5m, 2h) or an ISO time, got "${raw}"`));
	}
	return ok(at);
}

export const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type Level = (typeof LEVELS)[number];
const SEVERITY: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

/** The filters `logs`, `exceptions` and `network` share (`since` is a duration or ISO time). */
export type FilterParams = { since?: string; level?: string; grep?: string; limit?: number };

type LineFilter = { since?: number; level?: Level; grep?: string; limit: number };

function parseLineFilter(
	session: OpSession,
	params: FilterParams,
	fallbackLimit: number
): Result<LineFilter, WardenError> {
	const since = params.since === undefined ? ok(undefined) : parseSince(params.since, session.host.now());
	if (!since.success) return since;
	const { level, limit = fallbackLimit } = params;
	if (!Number.isInteger(limit) || limit < 1)
		return fail(opError("usage", `limit must be a positive integer, got ${limit}`));
	if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
		return fail(opError("usage", `unknown level ${level}`, { hint: LEVELS.join(" | ") }));
	}
	return ok({
		limit,
		...(since.data === undefined ? {} : { since: since.data }),
		...(level === undefined ? {} : { level: level as Level }),
		...(params.grep === undefined ? {} : { grep: params.grep }),
	});
}

/** The collector file's rows through the same filter the broker applies; `total` counts the matches. */
function filterLines(all: ConsoleLine[], f: LineFilter, keep: (line: ConsoleLine) => boolean = () => true) {
	const grep = f.grep?.toLowerCase();
	const minimum = f.level === undefined ? undefined : SEVERITY[f.level];
	const matched = all.filter(
		(line) =>
			keep(line) &&
			(f.since === undefined || line.ts >= f.since) &&
			(minimum === undefined || (SEVERITY[line.level] ?? 0) >= minimum) &&
			(grep === undefined || line.text.toLowerCase().includes(grep))
	);
	return { total: matched.length, lines: matched.slice(-f.limit) };
}

const toQuery = (f: LineFilter): LineQuery => ({
	limit: f.limit,
	...(f.since === undefined ? {} : { since: f.since }),
	...(f.level === undefined ? {} : { level: f.level }),
	...(f.grep === undefined ? {} : { grep: f.grep }),
});

/** Which Metro serves this device: `metro`, `WARDEN_METRO_URL`, the remembered one, then the owner's leased ports. */
async function metroFor(
	session: OpSession,
	deps: DevtoolsDeps,
	flag: string | undefined
): Promise<Result<string, WardenError>> {
	const stateMetroUrl = session.state.read().metroUrl;
	const found = await findMetro({
		...(flag === undefined ? {} : { flag }),
		...(session.host.env.WARDEN_METRO_URL === undefined ? {} : { env: session.host.env.WARDEN_METRO_URL }),
		...(stateMetroUrl === undefined ? {} : { stateMetroUrl }),
		portLeases: [...(session.ports?.() ?? [])],
		probe: (port) => deps.probe(session.host, port),
	});
	if (found) return ok(found.url);
	return fail(
		opError(
			"devtools_unavailable",
			"no Metro found for this device: a release build, or the dev client was never pointed at one",
			{ hint: START_HINT }
		)
	);
}

/** Attach to the device's dev client, run `fn`, close the facet. */
export async function withFacet<T>(
	session: OpSession,
	opts: MetroParams,
	fn: (facet: DevtoolsFacet) => Promise<Result<T, WardenError>>
): Promise<Result<T, WardenError>> {
	const deps = depsOf(session);
	if (!deps.success) return deps;
	const metro = await metroFor(session, deps.data, opts.metro);
	if (!metro.success) return metro;
	const { app } = session.state.read();
	const { device } = session;
	const opened = await deps.data.open({
		env: { metroUrl: metro.data },
		device: {
			...(app === undefined ? {} : { appId: app }),
			...(device.platform === "ios" && device.name ? { deviceName: device.name } : {}),
		},
		fetch,
		WebSocket,
		timeoutMs: session.timeoutMs,
	});
	if (!opened.success) return fail(devtoolsError(opened.error));
	try {
		return await fn(opened.data);
	} finally {
		opened.data.close();
	}
}

function renderValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

export type EvalParams = MetroParams & { expression: string; await?: boolean };
export type EvalResult = { value: unknown };

/** `eval`: run JavaScript in the app and return the value. */
export async function evaluate(session: OpSession, params: EvalParams): OpOutcome<EvalResult> {
	const brokered = await viaBroker(session, params.metro, (broker) =>
		broker.eval({ expression: params.expression, timeoutMs: session.timeoutMs })
	);
	if (brokered !== undefined) {
		if (!brokered.success) return brokered;
		const { value } = brokered.data;
		return ok({ result: { value: value ?? null }, text: renderValue(value) });
	}
	return withFacet(session, params, async (facet) => {
		const evaluated = await facet.evaluate(params.expression, {
			await: params.await === true,
			timeoutMs: session.timeoutMs,
		});
		if (!evaluated.success) {
			const { message, code, exceptionDetails } = evaluated.error;
			if (code === "devtools_unavailable" || code === "device_mismatch") {
				return fail(devtoolsError({ code, message }));
			}
			return fail(opError("failed", message, exceptionDetails ? { details: { exception: exceptionDetails } } : {}));
		}
		return ok({ result: { value: evaluated.data ?? null }, text: renderValue(evaluated.data) });
	});
}

export type TreeParams = MetroParams & { all?: boolean; max?: number; screen?: string };

/** Android reports dp, snapshots speak px: ask the driver for the scale. */
async function pixelRatioFor(session: OpSession): Promise<number> {
	if (session.device.platform !== "android") return 1;
	const driver = await session.driver();
	if (!driver.success) return 1;
	const snapshot = await driver.data.snapshot();
	return snapshot.success ? snapshot.data.screen.scale : 1;
}

function treeOutcome(result: ReactTree, all: boolean): Result<OpDone<ReactTree>, WardenError> {
	const header = `# ${result.screen === undefined ? "screen unknown" : `screen ${result.screen}`} · ${result.components.length} components${result.truncated ? " (truncated)" : ""}`;
	return ok({
		result,
		text: [header, ...formatTree(result, { all })].join("\n"),
		warnings: result.truncated ? ["more components exist; raise --max"] : [],
	});
}

/** `tree`: the app's React components with rects. */
export async function tree(session: OpSession, params: TreeParams = {}): OpOutcome<ReactTree> {
	const pixelRatio = await pixelRatioFor(session);
	if (params.all !== true && params.screen === undefined) {
		const brokered = await viaBroker(session, params.metro, (broker) =>
			broker.tree({ ...(params.max === undefined ? {} : { max: params.max }), pixelRatio })
		);
		if (brokered !== undefined) {
			if (!brokered.success) return brokered;
			return treeOutcome(brokered.data, false);
		}
	}
	return withFacet(session, params, async (facet) => {
		const fetched = await facet.tree({
			all: params.all === true,
			...(params.max === undefined ? {} : { max: params.max }),
			...(params.screen === undefined ? {} : { screen: params.screen }),
			pixelRatio,
		});
		if (!fetched.success) return fail(devtoolsError(fetched.error));
		return treeOutcome(fetched.data, params.all === true);
	});
}

export type ReloadResult = { action: "reload"; method: "expo" | "devsettings" | "http" };

/** `reload`: reload the app's JS (Fast Refresh does not need it; this restarts the bundle). */
export async function reload(session: OpSession, params: MetroParams = {}): OpOutcome<ReloadResult> {
	const brokered = await viaBroker(session, params.metro, (broker) => broker.reload());
	if (brokered !== undefined) {
		if (!brokered.success) return brokered;
		return ok({
			result: { action: "reload", method: brokered.data.method },
			text: `reloaded (${brokered.data.method})`,
		});
	}
	return withFacet(session, params, async (facet) => {
		const reloaded = await facet.reloadJs();
		if (!reloaded.success) return fail(devtoolsError(reloaded.error));
		return ok({
			result: { action: "reload", method: reloaded.data.method },
			text: `reloaded (${reloaded.data.method})`,
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

/** What `logs` does: read the tail, run the collector, or edit the files. */
export type LogsParams =
	| ({ action: "tail"; count?: number } & FilterParams)
	| ({ action: "start"; bodies?: boolean } & MetroParams)
	| { action: "stop" }
	| { action: "mark"; label: string }
	| { action: "clear" };

export type LogsResult =
	| { file: string; total: number; lines: ConsoleLine[] }
	| { action: "logs"; state: "collecting"; via: "broker"; logDir: string }
	| { action: "logs"; state: "collecting"; pid: number; already: true }
	| { action: "logs"; state: "collecting"; pid: number; metroUrl: string; out: string }
	| { action: "logs"; state: "collecting"; pid: number }
	| { action: "logs"; state: "stopped"; pid: number }
	| { action: "logs"; mark: string }
	| { action: "logs"; cleared: true };

async function startCollector(
	session: OpSession,
	params: Extract<LogsParams, { action: "start" }>
): OpOutcome<LogsResult> {
	const deps = depsOf(session);
	if (!deps.success) return deps;
	const d = deps.data;
	const { host, device } = session;
	const state = session.state.read();
	const logDir = params.metro === undefined ? await d.broker?.logDir() : undefined;
	if (logDir !== undefined) {
		return ok({
			result: { action: "logs", state: "collecting", via: "broker", logDir },
			text: `the dev session's broker is already capturing console + network (${logDir})`,
		});
	}
	if (
		state.collector &&
		mayBeRecorded(d.collector, state.collector.pid, collectorMarks(host, device.id, state.collector))
	) {
		return ok({
			result: { action: "logs", state: "collecting", pid: state.collector.pid, already: true },
			text: `already collecting (pid ${state.collector.pid})`,
		});
	}
	const metro = await metroFor(session, d, params.metro);
	if (!metro.success) return metro;
	const out = uiDir(host.home, device.id);
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
		...(params.bodies === true ? ["--include-bodies"] : []),
	];
	const { pid } = d.collector.spawnDetached({ cmd, logPath: join(out, COLLECTOR_LOG) });
	session.state.update((current) => ({ ...current, collector: { pid, startedAt: host.now(), out } }));
	return ok({
		result: { action: "logs", state: "collecting", pid, metroUrl: metro.data, out },
		text: `collecting console + network to ${out} (pid ${pid}); stops after 60 s without activity`,
	});
}

async function stopCollector(session: OpSession): OpOutcome<LogsResult> {
	const running = session.state.read().collector;
	if (!running) return fail(opError("usage", "not collecting", { hint: COLLECT_HINT }));
	const deps = depsOf(session);
	if (!deps.success) return deps;
	const d = deps.data;
	const identity = recordedIdentity(d.collector, running.pid, collectorMarks(session.host, session.device.id, running));
	if (identity === "unknown") {
		// alive but its command line unreadable: it may still be the collector, so it is neither signalled nor forgotten
		return ok({
			result: { action: "logs", state: "collecting", pid: running.pid },
			text: `collector (pid ${running.pid}) left running`,
			warnings: [`could not stop the collector (pid ${running.pid}): its command line could not be read`],
		});
	}
	if (identity === "match") d.collector.kill(running.pid, "SIGTERM");
	session.state.update((current) => {
		if (current.collector?.pid !== running.pid) return current;
		const { collector: _stopped, ...rest } = current;
		return rest;
	});
	return ok({
		result: { action: "logs", state: "stopped", pid: running.pid },
		text: `stopped collector (pid ${running.pid})`,
	});
}

function markLog(session: OpSession, raw: string): Result<OpDone<LogsResult>, WardenError> {
	const label = raw.trim();
	if (label === "") return fail(opError("usage", "logs mark needs a label"));
	const dir = uiDir(session.host.home, session.device.id);
	const line: ConsoleLine = { ts: session.host.now(), level: "info", kind: "note", text: label };
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, CONSOLE_FILE), `${JSON.stringify(line)}\n`);
	return ok({ result: { action: "logs", mark: label }, text: `marked "${label}"` });
}

function clearLogs(session: OpSession): Result<OpDone<LogsResult>, WardenError> {
	const dir = uiDir(session.host.home, session.device.id);
	for (const name of [CONSOLE_FILE, NETWORK_FILE]) {
		const path = join(dir, name);
		if (existsSync(path)) writeFileSync(path, "");
	}
	return ok({ result: { action: "logs", cleared: true }, text: "cleared console and network logs" });
}

/**
 * `logs`: `start` runs a detached collector (`warden ui-collect`) that appends the app's console and network to
 * `<home>/ui/<udid>/{console,network}.jsonl`; the other forms read or edit those files, so they work after the
 * collector has ended too.
 */
export async function logs(session: OpSession, params: LogsParams): OpOutcome<LogsResult> {
	const { host, device } = session;
	const dir = uiDir(host.home, device.id);
	const file = join(dir, CONSOLE_FILE);
	if (params.action === "start") return startCollector(session, params);
	if (params.action === "stop") return stopCollector(session);
	if (params.action === "mark") return markLog(session, params.label);
	if (params.action === "clear") return clearLogs(session);
	const filter = parseLineFilter(session, { ...params, limit: params.limit ?? params.count }, DEFAULT_TAIL);
	if (!filter.success) return filter;
	const brokered = await viaBroker(session, undefined, (broker) => broker.console(toQuery(filter.data)));
	if (brokered !== undefined) return brokered.success ? linesOutcome(brokered.data) : brokered;
	if (!existsSync(file)) return fail(opError("usage", "no console log yet", { hint: COLLECT_HINT }));
	const { total, lines } = filterLines(readJsonl<ConsoleLine>(file), filter.data);
	return linesOutcome({ file, total, lines });
}

function linesOutcome(found: BrokerLines): Result<OpDone<BrokerLines>, WardenError> {
	return ok({ result: found, text: found.lines.map(consoleLine).join("\n") });
}

/** `exceptions`: the app's uncaught exceptions (the broker's, else the collector's file). */
export async function exceptions(
	session: OpSession,
	params: Pick<FilterParams, "since" | "limit"> = {}
): OpOutcome<BrokerLines> {
	const filter = parseLineFilter(session, params, DEFAULT_TAIL);
	if (!filter.success) return filter;
	const { limit, since } = filter.data;
	const brokered = await viaBroker(session, undefined, (broker) =>
		broker.exceptions({ limit, ...(since === undefined ? {} : { since }) })
	);
	if (brokered !== undefined) return brokered.success ? linesOutcome(brokered.data) : brokered;
	const file = join(uiDir(session.host.home, session.device.id), CONSOLE_FILE);
	if (!existsSync(file)) return fail(opError("usage", "no console log yet", { hint: COLLECT_HINT }));
	const isException = session.devtools?.isAppException ?? ((line: ConsoleLine) => line.kind === "exception");
	const { total, lines } = filterLines(readJsonl<ConsoleLine>(file), filter.data, isException);
	return linesOutcome({ file, total, lines });
}

export const NETWORK_INCLUDES = ["headers", "body"] as const;
export type NetworkInclude = (typeof NETWORK_INCLUDES)[number];

export type NetworkParams = {
	/** entries to show (default 50) */
	count?: number;
	limit?: number;
	/** only entries since a duration back (`5m`) or an ISO time */
	since?: string;
	/** only entries whose url contains this (case-insensitive) */
	grep?: string;
	/** a code (`404`) or a class (`4xx`) */
	status?: string;
	include?: readonly NetworkInclude[];
	/** one entry in full */
	id?: number;
};

export type NetworkResult = { entry: NetworkEntry } | { file: string; total: number; entries: NetworkEntry[] };

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

function parseEntryQuery(session: OpSession, params: NetworkParams): Result<EntryQuery, WardenError> {
	const base = parseLineFilter(
		session,
		{ ...(params.since === undefined ? {} : { since: params.since }), limit: params.limit ?? params.count },
		DEFAULT_TAIL
	);
	if (!base.success) return base;
	const raw = params.status;
	if (raw !== undefined && !/^(\d{3}|[1-5]xx)$/.test(raw)) {
		return fail(opError("usage", `status must be a code (404) or a class (4xx), got "${raw}"`));
	}
	return ok({
		limit: base.data.limit,
		...(base.data.since === undefined ? {} : { since: base.data.since }),
		...(params.grep === undefined ? {} : { urlGrep: params.grep }),
		...(raw === undefined ? {} : { status: /^\d{3}$/.test(raw) ? Number(raw) : raw }),
	});
}

/** The broker's `network.query` filter applied to a collector row. */
function entryMatches(entry: NetworkEntry, f: EntryQuery): boolean {
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

const NO_ENTRY_HINT = "`warden ui network` lists ids";

async function networkById(session: OpSession, id: number, file: string): OpOutcome<NetworkResult> {
	const brokered = await viaBroker(session, undefined, (broker) => broker.networkEntry(id));
	if (brokered !== undefined && !brokered.success) return brokered;
	let entry = brokered?.success ? brokered.data : undefined;
	if (brokered === undefined) {
		if (!existsSync(file)) return fail(opError("usage", "no network log yet", { hint: COLLECT_HINT }));
		entry = readJsonl<NetworkEntry>(file).find((candidate) => candidate.id === id);
	}
	if (!entry) return fail(opError("target_not_found", `no network entry #${id}`, { hint: NO_ENTRY_HINT }));
	return ok({ result: { entry }, text: networkDetail(entry, new Set(NETWORK_INCLUDES)) });
}

/** `network`: what the app's `fetch` calls did (the broker's, else what the collector recorded). */
export async function network(session: OpSession, params: NetworkParams = {}): OpOutcome<NetworkResult> {
	const include = new Set<string>(params.include ?? []);
	const file = join(uiDir(session.host.home, session.device.id), NETWORK_FILE);
	if (params.id !== undefined) return networkById(session, params.id, file);
	const query = parseEntryQuery(session, params);
	if (!query.success) return query;
	const brokered = await viaBroker(session, undefined, (broker) => broker.network(query.data));
	if (brokered !== undefined) {
		if (!brokered.success) return brokered;
		return entriesOutcome(brokered.data, include);
	}
	if (!existsSync(file)) return fail(opError("usage", "no network log yet", { hint: COLLECT_HINT }));
	const matched = readJsonl<NetworkEntry>(file).filter((entry) => entryMatches(entry, query.data));
	return entriesOutcome({ file, total: matched.length, entries: matched.slice(-query.data.limit) }, include);
}

function entriesOutcome(
	found: BrokerEntries,
	include: ReadonlySet<string>
): Result<OpDone<NetworkResult>, WardenError> {
	return ok({
		result: found,
		text: found.entries.map((entry) => networkDetail(entry, include)).join("\n"),
	});
}

/** `devtools status`: the dev session's broker (attached, yielded to Chrome DevTools, lost, ...). */
export async function devtoolsStatus(session: OpSession): OpOutcome<BrokerStatusView> {
	const broker = session.devtools?.broker;
	if (broker === undefined) return fail(noBroker());
	const status = await broker.status();
	if (!status.success) return status;
	const { state, console: lines, network: net, session: dev } = status.data;
	return ok({
		result: status.data,
		text: [
			`broker ${state.phase}`,
			`metro ${dev.metroUrl} · pid ${status.data.pid}`,
			`console ${lines.buffered}/${lines.total} · network ${net.buffered}/${net.total}`,
			`methods ${status.data.methods.join(", ")}`,
		].join("\n"),
	});
}

/** `devtools resume`: take the page back after the broker yielded to Chrome DevTools. */
export async function devtoolsResume(session: OpSession): OpOutcome<{ state: BrokerStateView }> {
	const broker = session.devtools?.broker;
	if (broker === undefined) return fail(noBroker());
	const resumed = await broker.resume();
	if (!resumed.success) return resumed;
	return ok({ result: resumed.data, text: `broker ${resumed.data.state.phase}` });
}

const noBroker = (): WardenError =>
	opError("devtools_unavailable", "no `warden dev` session is running for this device", {
		hint: "start one with `warden dev`",
	});
