import type { RecordedEvent, Telemetry } from "@delacournz/cli-telemetry";
import {
	type CommandLike,
	commandPathOf,
	errorKindOf,
	flagsSetOnCli,
	platformOf,
	suitesOf,
	type WardenCommandProperties,
} from "./properties";

/**
 * One command's telemetry, from `preAction` to the exit.
 *
 * `begin` runs before the action: it shows the first-run notice and snapshots what was typed. `finish` runs
 * after, once, with the outcome: it builds the single `command` event, records it and awaits a flush bounded
 * at 1.5 s, so `cli.ts` can `process.exit` straight after without dropping the event. Nothing here throws:
 * telemetry is never the reason a command fails.
 *
 * Commands that are not counted: `version` (a script calls it to ask what is installed), `telemetry` (counting people who inspect or switch this off would be a poor
 * way to treat them), `hook` and `heartbeat` (they run on every agent tool call and every 30 s; a flush
 * there would be latency for nothing) and the hidden workers (`__scheduler`, `perf-collect` …), which are
 * children of a command that was counted. Commands that may never return (`dev`, `mcp`, anything with
 * `--follow`) record and flush at the start instead.
 *
 * Output: the notice goes to stderr only, never stdout, so `--json` documents and MCP stdio stay intact. It
 * waits for a run without `--quiet` / `--silent`; the event is counted regardless.
 */

export type Outcome = "success" | "error" | "cancelled";

export const FLUSH_TIMEOUT_MS = 1500;

export type Finished = { outcome: Outcome; error?: unknown; exitCode?: number };

export type Tracker = {
	begin(command: CommandLike): Promise<void>;
	finish(result: Finished): Promise<void>;
};

export type TrackerOptions = {
	/** Resolved on first use, so a process that never records never loads the client; `undefined` when telemetry is certainly off. */
	telemetry: () => Promise<Telemetry | undefined>;
	stderr: (line: string) => void;
	now?: () => number;
};

const NEVER_COUNTED: ReadonlySet<string> = new Set([
	"telemetry",
	"hook",
	"heartbeat",
	"complete",
	"version",
	"ui-collect",
	"perf-collect",
]);
const LONG_RUNNING: ReadonlySet<string> = new Set(["dev", "mcp"]);

function isCounted(path: string): boolean {
	const root = path.split(" ")[0] ?? "";
	return !root.startsWith("__") && !NEVER_COUNTED.has(root);
}

type Snapshot = {
	properties: WardenCommandProperties;
	startedAt: number;
	telemetry: Telemetry;
};

/** The typed-in facts of one invocation, as the single set of properties a `command` event starts from. */
function propertiesOf(command: CommandLike, path: string): WardenCommandProperties {
	const platform = platformOf(command);
	const suites = suitesOf(command);
	return {
		command: path,
		flags: flagsSetOnCli(command),
		json: command.opts().json === true,
		...(platform ? { platform } : {}),
		...(suites !== undefined ? { suites } : {}),
	};
}

/** Held back from the notice, not from the count: a run that asked for quiet gets its notice on a later one. */
function isQuiet(opts: Record<string, unknown>): boolean {
	return opts.quiet === true || opts.silent === true;
}

/** `dev`, `mcp` and anything following a stream may never return, so they report when they start. */
function reportsAtStart(path: string, opts: Record<string, unknown>): boolean {
	return LONG_RUNNING.has(path) || opts.follow === true;
}

export function createTracker(options: TrackerOptions): Tracker {
	const now = options.now ?? Date.now;
	let snapshot: Snapshot | undefined;

	function event(taken: Snapshot, result: Finished): RecordedEvent {
		const properties: WardenCommandProperties = {
			...taken.properties,
			...(result.error !== undefined ? { errorKind: errorKindOf(result.error) } : {}),
			...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
		};
		return { name: "command", outcome: result.outcome, durationMs: now() - taken.startedAt, properties };
	}

	function announce(telemetry: Telemetry, opts: Record<string, unknown>): void {
		if (isQuiet(opts) || !telemetry.shouldShowNotice()) return;
		options.stderr(`\n${telemetry.noticeText}`);
		telemetry.markNoticeShown();
	}

	return {
		async begin(command) {
			try {
				const path = commandPathOf(command);
				if (!isCounted(path)) return;

				const opts = command.opts();
				const telemetry = await options.telemetry();
				if (!telemetry) return;
				announce(telemetry, opts);
				if (!telemetry.enabled) return;

				const taken: Snapshot = { properties: propertiesOf(command, path), startedAt: now(), telemetry };
				if (!reportsAtStart(path, opts)) {
					snapshot = taken;
					return;
				}
				telemetry.record(event(taken, { outcome: "success" }));
				await telemetry.flush({ timeoutMs: FLUSH_TIMEOUT_MS });
			} catch {}
		},

		async finish(result) {
			try {
				const taken = snapshot;
				snapshot = undefined;
				if (!taken) return;
				taken.telemetry.record(event(taken, result));
				await taken.telemetry.flush({ timeoutMs: FLUSH_TIMEOUT_MS });
			} catch {}
		},
	};
}
