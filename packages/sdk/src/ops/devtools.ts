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
import { type MetroProbe, metroFinder } from "@delacour/warden-devtools/metro";
import { treeFormatter } from "@delacour/warden-devtools/tree";
import type { PidAlive } from "@delacour/warden-store/liveness";
import { type ProcessCommand, processIdentity } from "@delacour/warden-store/process-identity";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type {
	BrokerEntries,
	BrokerLines,
	BrokerPort,
	BrokerStateView,
	BrokerStatusView,
	EntryQuery,
	LineQuery,
} from "./broker-port";
import { opErrors } from "./errors";
import { uiPaths } from "./paths";
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

/** Options every devtools op takes. */
export type MetroParams = { metro?: string };

const SINCE_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type Level = (typeof LEVELS)[number];
const SEVERITY: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

/** The filters `logs`, `exceptions` and `network` share (`since` is a duration or ISO time). */
export type FilterParams = { since?: string; level?: string; grep?: string; limit?: number };

type LineFilter = { since?: number; level?: Level; grep?: string; limit: number };

export type EvalParams = MetroParams & { expression: string; await?: boolean };
export type EvalResult = { value: unknown };

export type TreeParams = MetroParams & { all?: boolean; max?: number; screen?: string };

export type ReloadResult = { action: "reload"; method: "expo" | "devsettings" | "http" };

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

const NO_ENTRY_HINT = "`warden ui network` lists ids";

export class DevtoolsOps {
	/**
	 * What the collector's command line carries (`ui-collect --out <device dir>`): tells it from a reused pid. The dir is
	 * the one recorded at start (a record from an older warden has none: today's spelling of it).
	 */
	private collectorMarks(host: OpHost, udid: string, record: CollectorRecord): string[] {
		return ["ui-collect", `--out ${record.out ?? uiPaths.uiDir(host.home, udid)}`];
	}

	/** A devtools failure as an op error: no dev client (`devtools_unavailable`) or a plain failure. */
	devtoolsError(error: DevtoolsError): WardenError {
		const unreachable = error.code === "devtools_unavailable" || error.code === "device_mismatch";
		return unreachable
			? opErrors.opError("devtools_unavailable", error.message, { hint: START_HINT, details: { devtools: error.code } })
			: opErrors.opError("failed", `${error.code}: ${error.message}`, { details: { devtools: error.code } });
	}

	private depsOf(session: OpSession): Result<DevtoolsDeps, WardenError> {
		return session.devtools
			? resultFactory.ok(session.devtools)
			: opErrors.fail(opErrors.opError("engine_unavailable", "this session has no devtools deps (Metro access)"));
	}

	/**
	 * Runs `run` against the dev session's broker. Undefined = go direct: `metro` names a Metro, no broker is wired or
	 * answers, or its socket vanished mid-call.
	 */
	private async viaBroker<T>(
		session: OpSession,
		metro: string | undefined,
		run: (broker: BrokerPort) => Promise<Result<T, WardenError> | undefined>
	): Promise<Result<T, WardenError> | undefined> {
		const broker = session.devtools?.broker;
		if (broker === undefined || metro !== undefined) return undefined;
		return run(broker);
	}

	/** `since`: a duration back from `now` (`30s`, `5m`, `2h`, `1d`, `250ms`) or an ISO time, as epoch ms. */
	parseSince(raw: string, now: number): Result<number, WardenError> {
		const duration = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
		if (duration !== null) return resultFactory.ok(now - Number(duration[1]) * (SINCE_UNITS[duration[2] ?? "ms"] ?? 1));
		const at = Date.parse(raw);
		if (Number.isNaN(at)) {
			return opErrors.fail(
				opErrors.opError("usage", `--since must be a duration (30s, 5m, 2h) or an ISO time, got "${raw}"`)
			);
		}
		return resultFactory.ok(at);
	}

	private parseLineFilter(
		session: OpSession,
		params: FilterParams,
		fallbackLimit: number
	): Result<LineFilter, WardenError> {
		const since =
			params.since === undefined ? resultFactory.ok(undefined) : this.parseSince(params.since, session.host.now());
		if (!since.success) return since;
		const { level, limit = fallbackLimit } = params;
		if (!Number.isInteger(limit) || limit < 1)
			return opErrors.fail(opErrors.opError("usage", `limit must be a positive integer, got ${limit}`));
		if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
			return opErrors.fail(opErrors.opError("usage", `unknown level ${level}`, { hint: LEVELS.join(" | ") }));
		}
		return resultFactory.ok({
			limit,
			...(since.data === undefined ? {} : { since: since.data }),
			...(level === undefined ? {} : { level: level as Level }),
			...(params.grep === undefined ? {} : { grep: params.grep }),
		});
	}

	/** The collector file's rows through the same filter the broker applies; `total` counts the matches. */
	private filterLines(all: ConsoleLine[], f: LineFilter, keep: (line: ConsoleLine) => boolean = () => true) {
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

	private toQuery(f: LineFilter): LineQuery {
		return {
			limit: f.limit,
			...(f.since === undefined ? {} : { since: f.since }),
			...(f.level === undefined ? {} : { level: f.level }),
			...(f.grep === undefined ? {} : { grep: f.grep }),
		};
	}

	/** Which Metro serves this device: `metro`, `WARDEN_METRO_URL`, the remembered one, then the owner's leased ports. */
	private async metroFor(
		session: OpSession,
		deps: DevtoolsDeps,
		flag: string | undefined
	): Promise<Result<string, WardenError>> {
		const stateMetroUrl = session.state.read().metroUrl;
		const found = await metroFinder.find({
			...(flag === undefined ? {} : { flag }),
			...(session.host.env.WARDEN_METRO_URL === undefined ? {} : { env: session.host.env.WARDEN_METRO_URL }),
			...(stateMetroUrl === undefined ? {} : { stateMetroUrl }),
			portLeases: [...(session.ports?.() ?? [])],
			probe: (port) => deps.probe(session.host, port),
		});
		if (found) return resultFactory.ok(found.url);
		return opErrors.fail(
			opErrors.opError(
				"devtools_unavailable",
				"no Metro found for this device: a release build, or the dev client was never pointed at one",
				{ hint: START_HINT }
			)
		);
	}

	/** Attach to the device's dev client, run `fn`, close the facet. */
	async withFacet<T>(
		session: OpSession,
		opts: MetroParams,
		fn: (facet: DevtoolsFacet) => Promise<Result<T, WardenError>>
	): Promise<Result<T, WardenError>> {
		const deps = this.depsOf(session);
		if (!deps.success) return deps;
		const metro = await this.metroFor(session, deps.data, opts.metro);
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
		if (!opened.success) return opErrors.fail(this.devtoolsError(opened.error));
		try {
			return await fn(opened.data);
		} finally {
			opened.data.close();
		}
	}

	private renderValue(value: unknown): string {
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value;
		return JSON.stringify(value, null, 2) ?? String(value);
	}

	/** `eval`: run JavaScript in the app and return the value. */
	async evaluate(session: OpSession, params: EvalParams): OpOutcome<EvalResult> {
		const brokered = await this.viaBroker(session, params.metro, (broker) =>
			broker.eval({ expression: params.expression, timeoutMs: session.timeoutMs })
		);
		if (brokered !== undefined) {
			if (!brokered.success) return brokered;
			const { value } = brokered.data;
			return resultFactory.ok({ result: { value: value ?? null }, text: this.renderValue(value) });
		}
		return this.withFacet(session, params, async (facet) => {
			const evaluated = await facet.evaluate(params.expression, {
				await: params.await === true,
				timeoutMs: session.timeoutMs,
			});
			if (!evaluated.success) {
				const { message, code, exceptionDetails } = evaluated.error;
				if (code === "devtools_unavailable" || code === "device_mismatch") {
					return opErrors.fail(this.devtoolsError({ code, message }));
				}
				return opErrors.fail(
					opErrors.opError("failed", message, exceptionDetails ? { details: { exception: exceptionDetails } } : {})
				);
			}
			return resultFactory.ok({ result: { value: evaluated.data ?? null }, text: this.renderValue(evaluated.data) });
		});
	}

	/** Android reports dp, snapshots speak px: ask the driver for the scale. */
	private async pixelRatioFor(session: OpSession): Promise<number> {
		if (session.device.platform !== "android") return 1;
		const driver = await session.driver();
		if (!driver.success) return 1;
		const snapshot = await driver.data.snapshot();
		return snapshot.success ? snapshot.data.screen.scale : 1;
	}

	private treeOutcome(result: ReactTree, all: boolean): Result<OpDone<ReactTree>, WardenError> {
		const header = `# ${result.screen === undefined ? "screen unknown" : `screen ${result.screen}`} · ${result.components.length} components${result.truncated ? " (truncated)" : ""}`;
		return resultFactory.ok({
			result,
			text: [header, ...treeFormatter.format(result, { all })].join("\n"),
			warnings: result.truncated ? ["more components exist; raise --max"] : [],
		});
	}

	/** `tree`: the app's React components with rects. */
	async tree(session: OpSession, params: TreeParams = {}): OpOutcome<ReactTree> {
		const pixelRatio = await this.pixelRatioFor(session);
		if (params.all !== true && params.screen === undefined) {
			const brokered = await this.viaBroker(session, params.metro, (broker) =>
				broker.tree({ ...(params.max === undefined ? {} : { max: params.max }), pixelRatio })
			);
			if (brokered !== undefined) {
				if (!brokered.success) return brokered;
				return this.treeOutcome(brokered.data, false);
			}
		}
		return this.withFacet(session, params, async (facet) => {
			const fetched = await facet.tree({
				all: params.all === true,
				...(params.max === undefined ? {} : { max: params.max }),
				...(params.screen === undefined ? {} : { screen: params.screen }),
				pixelRatio,
			});
			if (!fetched.success) return opErrors.fail(this.devtoolsError(fetched.error));
			return this.treeOutcome(fetched.data, params.all === true);
		});
	}

	/** `reload`: reload the app's JS (Fast Refresh does not need it; this restarts the bundle). */
	async reload(session: OpSession, params: MetroParams = {}): OpOutcome<ReloadResult> {
		const brokered = await this.viaBroker(session, params.metro, (broker) => broker.reload());
		if (brokered !== undefined) {
			if (!brokered.success) return brokered;
			return resultFactory.ok({
				result: { action: "reload", method: brokered.data.method },
				text: `reloaded (${brokered.data.method})`,
			});
		}
		return this.withFacet(session, params, async (facet) => {
			const reloaded = await facet.reloadJs();
			if (!reloaded.success) return opErrors.fail(this.devtoolsError(reloaded.error));
			return resultFactory.ok({
				result: { action: "reload", method: reloaded.data.method },
				text: `reloaded (${reloaded.data.method})`,
			});
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

	private consoleLine(line: ConsoleLine): string {
		const mark = line.kind === "note" ? "--" : line.kind === "exception" ? "!!" : line.level;
		return `${this.clock(line.ts)} ${mark} ${line.text}`;
	}

	private async startCollector(
		session: OpSession,
		params: Extract<LogsParams, { action: "start" }>
	): OpOutcome<LogsResult> {
		const deps = this.depsOf(session);
		if (!deps.success) return deps;
		const d = deps.data;
		const { host, device } = session;
		const state = session.state.read();
		const logDir = params.metro === undefined ? await d.broker?.logDir() : undefined;
		if (logDir !== undefined) {
			return resultFactory.ok({
				result: { action: "logs", state: "collecting", via: "broker", logDir },
				text: `the dev session's broker is already capturing console + network (${logDir})`,
			});
		}
		if (
			state.collector &&
			processIdentity.mayBeRecorded(
				d.collector,
				state.collector.pid,
				this.collectorMarks(host, device.id, state.collector)
			)
		) {
			return resultFactory.ok({
				result: { action: "logs", state: "collecting", pid: state.collector.pid, already: true },
				text: `already collecting (pid ${state.collector.pid})`,
			});
		}
		const metro = await this.metroFor(session, d, params.metro);
		if (!metro.success) return metro;
		const out = uiPaths.uiDir(host.home, device.id);
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
		return resultFactory.ok({
			result: { action: "logs", state: "collecting", pid, metroUrl: metro.data, out },
			text: `collecting console + network to ${out} (pid ${pid}); stops after 60 s without activity`,
		});
	}

	private async stopCollector(session: OpSession): OpOutcome<LogsResult> {
		const running = session.state.read().collector;
		if (!running) return opErrors.fail(opErrors.opError("usage", "not collecting", { hint: COLLECT_HINT }));
		const deps = this.depsOf(session);
		if (!deps.success) return deps;
		const d = deps.data;
		const identity = processIdentity.recordedIdentity(
			d.collector,
			running.pid,
			this.collectorMarks(session.host, session.device.id, running)
		);
		if (identity === "unknown") {
			// alive but its command line unreadable: it may still be the collector, so it is neither signalled nor forgotten
			return resultFactory.ok({
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
		return resultFactory.ok({
			result: { action: "logs", state: "stopped", pid: running.pid },
			text: `stopped collector (pid ${running.pid})`,
		});
	}

	private markLog(session: OpSession, raw: string): Result<OpDone<LogsResult>, WardenError> {
		const label = raw.trim();
		if (label === "") return opErrors.fail(opErrors.opError("usage", "logs mark needs a label"));
		const dir = uiPaths.uiDir(session.host.home, session.device.id);
		const line: ConsoleLine = { ts: session.host.now(), level: "info", kind: "note", text: label };
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, CONSOLE_FILE), `${JSON.stringify(line)}\n`);
		return resultFactory.ok({ result: { action: "logs", mark: label }, text: `marked "${label}"` });
	}

	private clearLogs(session: OpSession): Result<OpDone<LogsResult>, WardenError> {
		const dir = uiPaths.uiDir(session.host.home, session.device.id);
		for (const name of [CONSOLE_FILE, NETWORK_FILE]) {
			const path = join(dir, name);
			if (existsSync(path)) writeFileSync(path, "");
		}
		return resultFactory.ok({ result: { action: "logs", cleared: true }, text: "cleared console and network logs" });
	}

	/**
	 * `logs`: `start` runs a detached collector (`warden ui-collect`) that appends the app's console and network to
	 * `<home>/ui/<udid>/{console,network}.jsonl`; the other forms read or edit those files, so they work after the
	 * collector has ended too.
	 */
	async logs(session: OpSession, params: LogsParams): OpOutcome<LogsResult> {
		const { host, device } = session;
		const dir = uiPaths.uiDir(host.home, device.id);
		const file = join(dir, CONSOLE_FILE);
		if (params.action === "start") return this.startCollector(session, params);
		if (params.action === "stop") return this.stopCollector(session);
		if (params.action === "mark") return this.markLog(session, params.label);
		if (params.action === "clear") return this.clearLogs(session);
		const filter = this.parseLineFilter(session, { ...params, limit: params.limit ?? params.count }, DEFAULT_TAIL);
		if (!filter.success) return filter;
		const brokered = await this.viaBroker(session, undefined, (broker) => broker.console(this.toQuery(filter.data)));
		if (brokered !== undefined) return brokered.success ? this.linesOutcome(brokered.data) : brokered;
		if (!existsSync(file))
			return opErrors.fail(opErrors.opError("usage", "no console log yet", { hint: COLLECT_HINT }));
		const { total, lines } = this.filterLines(this.readJsonl<ConsoleLine>(file), filter.data);
		return this.linesOutcome({ file, total, lines });
	}

	private linesOutcome(found: BrokerLines): Result<OpDone<BrokerLines>, WardenError> {
		return resultFactory.ok({ result: found, text: found.lines.map((line) => this.consoleLine(line)).join("\n") });
	}

	/** `exceptions`: the app's uncaught exceptions (the broker's, else the collector's file). */
	async exceptions(session: OpSession, params: Pick<FilterParams, "since" | "limit"> = {}): OpOutcome<BrokerLines> {
		const filter = this.parseLineFilter(session, params, DEFAULT_TAIL);
		if (!filter.success) return filter;
		const { limit, since } = filter.data;
		const brokered = await this.viaBroker(session, undefined, (broker) =>
			broker.exceptions({ limit, ...(since === undefined ? {} : { since }) })
		);
		if (brokered !== undefined) return brokered.success ? this.linesOutcome(brokered.data) : brokered;
		const file = join(uiPaths.uiDir(session.host.home, session.device.id), CONSOLE_FILE);
		if (!existsSync(file))
			return opErrors.fail(opErrors.opError("usage", "no console log yet", { hint: COLLECT_HINT }));
		const isException = session.devtools?.isAppException ?? ((line: ConsoleLine) => line.kind === "exception");
		const { total, lines } = this.filterLines(this.readJsonl<ConsoleLine>(file), filter.data, isException);
		return this.linesOutcome({ file, total, lines });
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

	private parseEntryQuery(session: OpSession, params: NetworkParams): Result<EntryQuery, WardenError> {
		const base = this.parseLineFilter(
			session,
			{ ...(params.since === undefined ? {} : { since: params.since }), limit: params.limit ?? params.count },
			DEFAULT_TAIL
		);
		if (!base.success) return base;
		const raw = params.status;
		if (raw !== undefined && !/^(\d{3}|[1-5]xx)$/.test(raw)) {
			return opErrors.fail(opErrors.opError("usage", `status must be a code (404) or a class (4xx), got "${raw}"`));
		}
		return resultFactory.ok({
			limit: base.data.limit,
			...(base.data.since === undefined ? {} : { since: base.data.since }),
			...(params.grep === undefined ? {} : { urlGrep: params.grep }),
			...(raw === undefined ? {} : { status: /^\d{3}$/.test(raw) ? Number(raw) : raw }),
		});
	}

	/** The broker's `network.query` filter applied to a collector row. */
	private entryMatches(entry: NetworkEntry, f: EntryQuery): boolean {
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

	private async networkById(session: OpSession, id: number, file: string): OpOutcome<NetworkResult> {
		const brokered = await this.viaBroker(session, undefined, (broker) => broker.networkEntry(id));
		if (brokered !== undefined && !brokered.success) return brokered;
		let entry = brokered?.success ? brokered.data : undefined;
		if (brokered === undefined) {
			if (!existsSync(file))
				return opErrors.fail(opErrors.opError("usage", "no network log yet", { hint: COLLECT_HINT }));
			entry = this.readJsonl<NetworkEntry>(file).find((candidate) => candidate.id === id);
		}
		if (!entry)
			return opErrors.fail(opErrors.opError("target_not_found", `no network entry #${id}`, { hint: NO_ENTRY_HINT }));
		return resultFactory.ok({ result: { entry }, text: this.networkDetail(entry, new Set(NETWORK_INCLUDES)) });
	}

	/** `network`: what the app's `fetch` calls did (the broker's, else what the collector recorded). */
	async network(session: OpSession, params: NetworkParams = {}): OpOutcome<NetworkResult> {
		const include = new Set<string>(params.include ?? []);
		const file = join(uiPaths.uiDir(session.host.home, session.device.id), NETWORK_FILE);
		if (params.id !== undefined) return this.networkById(session, params.id, file);
		const query = this.parseEntryQuery(session, params);
		if (!query.success) return query;
		const brokered = await this.viaBroker(session, undefined, (broker) => broker.network(query.data));
		if (brokered !== undefined) {
			if (!brokered.success) return brokered;
			return this.entriesOutcome(brokered.data, include);
		}
		if (!existsSync(file))
			return opErrors.fail(opErrors.opError("usage", "no network log yet", { hint: COLLECT_HINT }));
		const matched = this.readJsonl<NetworkEntry>(file).filter((entry) => this.entryMatches(entry, query.data));
		return this.entriesOutcome({ file, total: matched.length, entries: matched.slice(-query.data.limit) }, include);
	}

	private entriesOutcome(
		found: BrokerEntries,
		include: ReadonlySet<string>
	): Result<OpDone<NetworkResult>, WardenError> {
		return resultFactory.ok({
			result: found,
			text: found.entries.map((entry) => this.networkDetail(entry, include)).join("\n"),
		});
	}

	/** `devtools status`: the dev session's broker (attached, yielded to Chrome DevTools, lost, ...). */
	async devtoolsStatus(session: OpSession): OpOutcome<BrokerStatusView> {
		const broker = session.devtools?.broker;
		if (broker === undefined) return opErrors.fail(this.noBroker());
		const status = await broker.status();
		if (!status.success) return status;
		const { state, console: lines, network: net, session: dev } = status.data;
		return resultFactory.ok({
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
	async devtoolsResume(session: OpSession): OpOutcome<{ state: BrokerStateView }> {
		const broker = session.devtools?.broker;
		if (broker === undefined) return opErrors.fail(this.noBroker());
		const resumed = await broker.resume();
		if (!resumed.success) return resumed;
		return resultFactory.ok({ result: resumed.data, text: `broker ${resumed.data.state.phase}` });
	}

	private noBroker(): WardenError {
		return opErrors.opError("devtools_unavailable", "no `warden dev` session is running for this device", {
			hint: "start one with `warden dev`",
		});
	}
}

export const devtoolsOps = new DevtoolsOps();
