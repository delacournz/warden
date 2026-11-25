import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import type { EventFilter, LeaseEvent } from "@delacour/warden-core/lease-events";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, reportError, table } from "../output";

/** How often `--follow` looks for new events. */
export const FOLLOW_POLL_MS = 1_000;

export type EventsDeps = {
	sleep: (ms: number) => Promise<void>;
	/** true ends `--follow` (Ctrl-C) */
	aborted: () => boolean;
};

type EventsOpts = { since?: string; lease?: string; owner?: string; follow?: true; json?: true };

/** Time of day plus date when it is not today, local time. */
function formatAt(at: number, now: number): string {
	const d = new Date(at);
	const time = d.toTimeString().slice(0, 8);
	return Math.abs(now - at) < 86_400_000 ? time : `${d.toISOString().slice(5, 10)} ${time}`;
}

/** The type-specific part of an event, one short string. */
export function eventDetail(e: LeaseEvent): string {
	switch (e.type) {
		case "requested":
			return `${e.data.count}x ${e.data.platform} ${e.data.profile}`;
		case "queued":
			return `${e.data.platform} ${e.data.profile}${e.data.reason ? ` [${e.data.reason}]` : ""}`;
		case "granted":
			return `${e.data.deviceName} (${e.data.action}, waited ${formatDuration(e.data.waitMs)})`;
		case "released":
		case "expired":
			return `held ${formatDuration(e.data.heldMs)}`;
		case "heartbeat_lost":
			return "";
		case "evicted":
			return e.data.deviceName;
		case "quarantined":
			return `${e.data.deviceName}${e.data.reason ? `: ${e.data.reason}` : ""}`;
		case "unquarantined":
			return e.data.deviceId;
		case "shutdown":
			return `${e.data.deviceName ?? e.data.deviceId} (${e.data.cause})`;
		case "device_unhealthy":
			return `${e.data.deviceId}${e.data.reason ? `: ${e.data.reason}` : ""}`;
		case "device_recovered":
			return e.data.deviceId;
		case "host_claimed":
			return `${e.data.deviceName} on ${e.data.host} (${e.data.remoteLeaseId})`;
		case "host_lost":
			return `${e.data.host} ${e.data.remoteLeaseId}: ${e.data.reason}`;
	}
}

function row(e: LeaseEvent, now: number): string[] {
	return [formatAt(e.at, now), e.type, e.leaseId ?? "", e.ownerKey ?? "", e.label ?? "", eventDetail(e)];
}

const HEADER = ["TIME", "EVENT", "LEASE", "OWNER", "LABEL", "DETAIL"];

/** `warden events`: the lease history, oldest first; `--follow` keeps printing new events until aborted. */
export async function runEvents(ctx: CommandContext, opts: EventsOpts, deps: EventsDeps): Promise<number> {
	const filter: EventFilter = {};
	if (opts.since !== undefined) {
		const since = parseDuration(opts.since);
		if (!since.success) {
			reportError(ctx, "events", `--since: ${since.error}`);
			return 1;
		}
		filter.since = ctx.now() - since.data;
	} else if (opts.follow) {
		filter.since = ctx.now();
	}
	if (opts.lease !== undefined) filter.leaseId = opts.lease;
	if (opts.owner !== undefined) filter.owner = opts.owner;
	const store = ctx.store();
	const first = store.listEvents(filter);
	if (!opts.follow) {
		const now = ctx.now();
		const text =
			first.length === 0
				? ctx.ui.color.dim("no events")
				: table(
						ctx,
						HEADER,
						first.map((e) => row(e, now))
					);
		emit(ctx, opts.json === true, { events: first }, text, { scope: "events", detail: plural(first.length, "event") });
		return 0;
	}
	const print = (events: LeaseEvent[]) => {
		const now = ctx.now();
		for (const e of events) {
			ctx.out(
				opts.json
					? JSON.stringify(e)
					: row(e, now)
							.filter((c) => c !== "")
							.join("  ")
			);
		}
	};
	print(first);
	let cursor = first.at(-1)?.id ?? store.listEvents({ ...filter, since: undefined }).at(-1)?.id ?? 0;
	while (!deps.aborted()) {
		await deps.sleep(FOLLOW_POLL_MS);
		const fresh = store.listEvents({ ...filter, afterId: cursor });
		print(fresh);
		cursor = fresh.at(-1)?.id ?? cursor;
	}
	return 0;
}

/** Ctrl-C ends a `--follow`. */
function sigintDeps(): EventsDeps & { stop: () => void } {
	let aborted = false;
	const onSigint = () => {
		aborted = true;
	};
	process.on("SIGINT", onSigint);
	return {
		sleep: (ms) => Bun.sleep(ms),
		aborted: () => aborted,
		stop: () => process.off("SIGINT", onSigint),
	};
}

export const eventsCommand = defineCommand({
	name: "events",
	group: "Lease",
	summary: "lease history: requested, queued, granted, released, expired, evicted, quarantined … (--follow to tail)",
	register: (cmd, ctx, done) => {
		cmd
			.option(
				"--since <duration>",
				"only events from the last duration, e.g. 1h (default: all kept; with --follow: new only)"
			)
			.option("--lease <id>", "only this lease's events")
			.option("--owner <owner>", "only events whose owner key (agent:<session>, user:<pid>, ci:<run>) contains this")
			.option("--follow", "keep printing new events (polls every 1 s) until Ctrl-C; with --json, NDJSON")
			.option("--json", "machine-readable output")
			.action(async (opts) => {
				const deps = sigintDeps();
				try {
					done(await runEvents(ctx, opts, deps));
				} finally {
					deps.stop();
				}
			});
	},
});
