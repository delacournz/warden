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
import { formatTree } from "@delacour/warden-e2e/devtools/tree";
import { ok, type Result } from "@delacour/warden-types/result";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { metroOwner } from "../metro";
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

function renderValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

type EvalOptionValues = DevtoolsOptionValues & { await?: true };

/** `warden ui eval <expr> [--await]`: run JavaScript in the app and print the value. */
export function uiEval(ctx: CommandContext, deps: UiDeps, expression: string, opts: EvalOptionValues): Promise<number> {
	return runUi(ctx, deps, "eval", opts, (device, env) =>
		withFacet(ctx, devtoolsDeps(deps), device, env, opts, async (facet) => {
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
		})
	);
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

/** `warden ui tree [--all] [--max n] [--screen name]`: the app's React components with rects. */
export function uiTree(ctx: CommandContext, deps: UiDeps, opts: TreeOptionValues): Promise<number> {
	return runUi(ctx, deps, "tree", opts, async (device, env) => {
		const max = opts.max === undefined ? ok(undefined) : positiveInt("--max", opts.max);
		if (!max.success) return max;
		const pixelRatio = await pixelRatioFor(device, env);
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
	return runUi(ctx, deps, "reload", opts, (device, env) =>
		withFacet(ctx, devtoolsDeps(deps), device, env, opts, async (facet) => {
			const reloaded = await facet.reloadJs();
			if (!reloaded.success) return { success: false, error: devtoolsUiError(reloaded.error) };
			return ok({
				device: infoOf(device),
				result: { action: "reload", method: reloaded.data.method },
				text: `reloaded (${reloaded.data.method})`,
			});
		})
	);
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

type LogsOptionValues = DevtoolsOptionValues & { bodies?: true };

async function startCollector(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	opts: LogsOptionValues
): Promise<Result<{ device: ReturnType<typeof infoOf>; result: unknown; text: string; warnings?: string[] }, UiError>> {
	const d = devtoolsDeps(deps);
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
		return logsTail(ctx, device, action);
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
function logsTail(ctx: CommandContext, device: UiDevice, action: string | undefined): Result<UiPayload, UiError> {
	const count = action === undefined ? ok(DEFAULT_TAIL) : positiveInt("n", action);
	if (!count.success) {
		return {
			success: false,
			error: uiError("usage", `unknown logs action "${action}"`, {
				hint: "logs [n] | start | stop | mark <label> | clear",
			}),
		};
	}
	const file = join(uiDir(ctx, device.udid), CONSOLE_FILE);
	if (!existsSync(file)) {
		return { success: false, error: uiError("usage", "no console log yet", { hint: COLLECT_HINT }) };
	}
	const all = readJsonl<ConsoleLine>(file);
	const lines = all.slice(-count.data);
	return ok({
		device: infoOf(device),
		result: { file, total: all.length, lines },
		text: lines.map(consoleLine).join("\n"),
	});
}

type NetworkOptionValues = UiOptionValues & { include?: string; id?: string };

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

/** `warden ui network [n] [--include headers,body] [--id <id>]`: what the collector recorded of the app's `fetch` calls. */
export function uiNetwork(
	ctx: CommandContext,
	deps: UiDeps,
	countArg: string | undefined,
	opts: NetworkOptionValues
): Promise<number> {
	return runUi(ctx, deps, "network", opts, async (device) => {
		const include = parseInclude(opts.include);
		if (!include.success) return include;
		const count = countArg === undefined ? ok(DEFAULT_TAIL) : positiveInt("n", countArg);
		if (!count.success) return count;
		const id = opts.id === undefined ? ok(undefined) : positiveInt("--id", opts.id);
		if (!id.success) return id;
		const file = join(uiDir(ctx, device.udid), NETWORK_FILE);
		if (!existsSync(file)) {
			return { success: false, error: uiError("usage", "no network log yet", { hint: COLLECT_HINT }) };
		}
		const all = readJsonl<NetworkEntry>(file);
		if (id.data !== undefined) return networkById(device, all, id.data);
		const entries = all.slice(-count.data);
		return ok({
			device: infoOf(device),
			result: { file, total: all.length, entries },
			text: entries.map((entry) => networkDetail(entry, include.data)).join("\n"),
		});
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

/** `warden ui network --id <id>`: one entry with headers and bodies. */
function networkById(device: UiDevice, all: NetworkEntry[], id: number): Result<UiPayload, UiError> {
	const entry = all.find((candidate) => candidate.id === id);
	if (!entry) {
		return {
			success: false,
			error: uiError("target_not_found", `no network entry #${id}`, { hint: "`warden ui network` lists ids" }),
		};
	}
	return ok({ device: infoOf(device), result: { entry }, text: networkDetail(entry, new Set(INCLUDES)) });
}
