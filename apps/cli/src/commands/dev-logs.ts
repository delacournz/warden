import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { parseDuration } from "@delacour/warden-core/duration";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type DevSessionDeps, findDevSession } from "../dev-session";
import type { MetroLogEntry, MetroLogKind } from "../dev-tui/metro-log";
import { parseMetroLog } from "../dev-tui/metro-log";
import { processOnSignal } from "../lease-session";
import {
	filterMetroLogs,
	followMetroLog,
	type MetroLogQuery,
	type MetroLogsError,
	metroLogUnavailable,
	parseMetroLogKinds,
	readMetroLogText,
} from "../metro-logs";
import { reportError } from "../output";

export type DevLogsOpts = {
	udid?: string;
	since?: string;
	tail?: string;
	grep?: string;
	kind?: string;
	follow?: boolean;
	json?: boolean;
};

/** Side effects of `warden dev logs`, injectable for tests. */
export type DevLogsDeps = DevSessionDeps & {
	sleep: (ms: number) => Promise<void>;
	/** aborts `--follow` (default: SIGINT / SIGTERM) */
	interrupt: (abort: () => void) => () => void;
};

const defaultDeps: DevLogsDeps = {
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error instanceof Error && "code" in error && error.code === "EPERM";
		}
	},
	sleep: (ms) => Bun.sleep(ms),
	interrupt: (abort) => {
		const offInt = processOnSignal("SIGINT", abort);
		const offTerm = processOnSignal("SIGTERM", abort);
		return () => {
			offInt();
			offTerm();
		};
	},
};

/** `30s` / `5m` ago, or an ISO time, as epoch ms. */
function parseSince(input: string, now: number): { ok: true; ms: number } | { ok: false; message: string } {
	const duration = parseDuration(input);
	if (duration.success) return { ok: true, ms: now - duration.data };
	const iso = Date.parse(input);
	if (Number.isNaN(iso)) return { ok: false, message: `invalid --since "${input}" (use 30s, 5m, 2h or an ISO time)` };
	return { ok: true, ms: iso };
}

function fail(ctx: CommandContext, json: boolean, error: MetroLogsError): number {
	if (json) ctx.out(JSON.stringify({ error }));
	else reportError(ctx, "dev logs", error.hint === undefined ? error.message : `${error.message} (${error.hint})`);
	return 1;
}

/** One entry: its JSON on a line (`--json`), else its text coloured by kind. */
function render(ctx: CommandContext, json: boolean, entry: MetroLogEntry): string {
	if (json) return JSON.stringify(entry);
	const { color } = ctx.ui;
	switch (entry.kind) {
		case "bundle_failed":
		case "error":
			return color.red(entry.text);
		case "warn":
			return color.yellow(entry.text);
		case "bundle_done":
			return color.green(entry.text);
		case "bundle_start":
		case "hmr":
		case "info":
			return color.dim(entry.text);
	}
}

/** The flags parsed: filters shared with `--follow`, and the one-shot `tail`. */
type ParsedLogsOpts = { filters: Omit<MetroLogQuery, "udid" | "projectRoot" | "tail">; tail?: number };

function parseLogsOpts(opts: DevLogsOpts, now: number): Result<ParsedLogsOpts, MetroLogsError> {
	const invalid = (message: string) => ({
		success: false as const,
		error: { code: "invalid_query" as const, message },
	});
	let sinceMs: number | undefined;
	if (opts.since !== undefined) {
		const since = parseSince(opts.since, now);
		if (!since.ok) return invalid(since.message);
		sinceMs = since.ms;
	}
	let tail: number | undefined;
	if (opts.tail !== undefined) {
		tail = Number(opts.tail);
		if (!Number.isInteger(tail) || tail < 0) return invalid(`invalid --tail "${opts.tail}" (a non-negative integer)`);
	}
	let kinds: MetroLogKind[] | undefined;
	if (opts.kind !== undefined) {
		const parsed = parseMetroLogKinds(opts.kind);
		if (!parsed.success) return parsed;
		kinds = parsed.data;
	}
	return ok({
		filters: {
			...(sinceMs === undefined ? {} : { sinceMs }),
			...(opts.grep === undefined ? {} : { grep: opts.grep }),
			...(kinds === undefined ? {} : { kinds }),
		},
		...(tail === undefined ? {} : { tail }),
	});
}

/** What is in the log now, filtered; a log not written since `sinceMs` has nothing newer. */
function initialEntries(
	log: { text: string; mtimeMs: number },
	parsed: ParsedLogsOpts
): Result<MetroLogEntry[], MetroLogsError> {
	const { filters, tail } = parsed;
	if (filters.sinceMs !== undefined && log.mtimeMs < filters.sinceMs) return ok([]);
	return filterMetroLogs(parseMetroLog(log.text), { ...filters, ...(tail === undefined ? {} : { tail }) });
}

/** `--follow`: new entries until `deps.interrupt` fires. */
async function follow(
	ctx: CommandContext,
	json: boolean,
	logDir: string,
	filters: ParsedLogsOpts["filters"],
	deps: DevLogsDeps
): Promise<number> {
	const controller = new AbortController();
	const release = deps.interrupt(() => controller.abort());
	try {
		const followed = await followMetroLog(
			logDir,
			filters,
			{ now: ctx.now, sleep: deps.sleep, signal: controller.signal },
			(entries) => {
				for (const entry of entries) ctx.out(render(ctx, json, entry));
			}
		);
		return followed.success ? 0 : fail(ctx, json, followed.error);
	} finally {
		release();
	}
}

/**
 * `warden dev logs`: the Metro output of a running `warden dev` session, classified. Prints the entries that match
 * the filters, then with `--follow` the new ones until interrupted. `--json` prints one JSON object per line.
 */
export async function devLogs(
	ctx: CommandContext,
	opts: DevLogsOpts,
	deps: DevLogsDeps = defaultDeps
): Promise<number> {
	const json = opts.json === true;
	const parsed = parseLogsOpts(opts, ctx.now());
	if (!parsed.success) return fail(ctx, json, parsed.error);
	const session = findDevSession(ctx.env, opts.udid === undefined ? {} : { udid: opts.udid }, deps);
	if (!session.success) return fail(ctx, json, session.error);
	const { logDir } = session.data;
	const log = readMetroLogText(join(logDir, "metro.log"));
	if (log === undefined) return fail(ctx, json, metroLogUnavailable(logDir));
	const initial = initialEntries(log, parsed.data);
	if (!initial.success) return fail(ctx, json, initial.error);
	for (const entry of initial.data) ctx.out(render(ctx, json, entry));
	return opts.follow === true ? follow(ctx, json, logDir, parsed.data.filters, deps) : 0;
}

/** Wires `logs` onto `warden dev`; `deps` is the test seam. */
export function registerDevLogs(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: DevLogsDeps = defaultDeps
): void {
	cmd
		.command("logs")
		.description("Metro output of a running `warden dev` session, classified (bundle errors, HMR, warnings)")
		.option("--udid <udid>", "the session on this device (default: the only running one)")
		.option(
			"--since <when>",
			"30s | 5m | ISO time: entries seen since (metro.log has no per-line times, so this only skips a log not written since, and filters followed entries)"
		)
		.option("--tail <n>", "only the last N matching entries")
		.option("--grep <regexp>", "entries whose text matches (case-insensitive)")
		.option("--kind <kinds>", "comma list of bundle_start,bundle_done,bundle_failed,hmr,error,warn,info")
		.option("--follow", "keep printing new entries until interrupted")
		.option("--json", "one JSON object per line")
		.action(async (opts) => done(await devLogs(ctx, opts, deps)));
}
