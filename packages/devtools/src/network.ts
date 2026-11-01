import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import type { DevtoolsResult, NetworkEntry, NetworkQuery, Sleep } from "./devtools.types";
import { writeJsonl } from "./jsonl";
import { NETWORK_DRAIN_EXPRESSION, networkInstallExpression } from "./network.script";
import type { DevtoolsSession } from "./session";

const DEFAULT_RING = 2_000;
const DEFAULT_POLL_MS = 500;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "10.0.2.2"];

export type NetworkOptions = {
	/** entries kept, in the page and on the host (default 2000) */
	ring?: number;
	/** Metro's URL: requests to it (and its loopback aliases on the same port) are not recorded */
	metroUrl?: string;
	/** record request text and response text up to 64 KB (default false) */
	includeBodies?: boolean;
	/** how often the page is drained (default 500 ms) */
	pollMs?: number;
	/** injectable for tests; defaults to a timer */
	sleep?: Sleep;
	/** called with each new entry once */
	sink?: (entry: NetworkEntry) => void;
};

export type NetworkCapture = {
	/** Drains the page, then answers from the buffer: all, the `last` n, or the one with `id`. */
	entries: (query?: NetworkQuery) => Promise<NetworkEntry[]>;
	/** Drops the buffer and whatever the page still holds. Ids keep counting. */
	clear: () => Promise<void>;
	writeJsonl: (path: string) => Promise<void>;
	/** stops polling (the page wrapper stays; it is harmless) */
	stop: () => void;
};

/** Every URL prefix that is the same Metro: its origin plus the loopback aliases of a simulator and an emulator. */
export function metroSkipPrefixes(metroUrl: string): string[] {
	let url: URL;
	try {
		url = new URL(metroUrl);
	} catch {
		return [];
	}
	const port = url.port ? `:${url.port}` : "";
	const prefixes = [url.origin, ...LOOPBACK_HOSTS.map((host) => `${url.protocol}//${host}${port}`)];
	return [...new Set(prefixes)];
}

const pageEntrySchema = z.looseObject({
	ts: z.number(),
	method: z.string(),
	url: z.string(),
	status: z.number(),
	durationMs: z.number(),
	requestHeaders: z.record(z.string(), z.string()),
	responseHeaders: z.record(z.string(), z.string()),
	requestBody: z.string().optional(),
	responseBody: z.string().optional(),
	responseBodyTruncated: z.boolean().optional(),
	error: z.string().optional(),
});

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record the app's `fetch` calls: patch `fetch` inside the page once, then drain its ring on a timer and
 * whenever a caller asks. A new JS context (reload) loses the wrapper, so it is re-installed on reconnect and
 * whenever a drain finds it missing; requests made before that are lost.
 */
export async function attachNetwork(
	session: DevtoolsSession,
	options: NetworkOptions = {}
): Promise<DevtoolsResult<NetworkCapture>> {
	const ring = options.ring ?? DEFAULT_RING;
	const sleep = options.sleep ?? timerSleep;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const installExpression = networkInstallExpression({
		ring,
		includeBodies: options.includeBodies ?? false,
		skipPrefixes: options.metroUrl ? metroSkipPrefixes(options.metroUrl) : [],
	});

	let buffer: NetworkEntry[] = [];
	let nextId = 1;
	let stopped = false;
	let queue: Promise<unknown> = Promise.resolve();

	/** one at a time, so a poll and an `entries()` never interleave */
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.catch(() => undefined);
		return run;
	};

	const install = async (): Promise<DevtoolsResult<true>> => {
		const installed = await session.evaluate(installExpression);
		if (installed.success) return ok(true);
		return { success: false, error: { code: installed.error.code ?? "eval_failed", message: installed.error.message } };
	};

	const take = (text: string): void => {
		let rows: unknown;
		try {
			rows = JSON.parse(text);
		} catch {
			return;
		}
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			const parsed = pageEntrySchema.safeParse(row);
			if (!parsed.success) continue;
			const entry: NetworkEntry = { ...parsed.data, id: nextId++ };
			buffer.push(entry);
			options.sink?.(entry);
		}
		if (buffer.length > ring) buffer = buffer.slice(buffer.length - ring);
	};

	const drain = async (): Promise<void> => {
		const drained = await session.evaluate(NETWORK_DRAIN_EXPRESSION);
		if (!drained.success) return;
		if (typeof drained.data === "string") take(drained.data);
		else if (drained.data === null) await install();
	};

	const first = await install();
	if (!first.success) return first;
	session.on("reconnected", () => {
		void serial(install);
	});

	const poll = async (): Promise<void> => {
		for (;;) {
			await sleep(pollMs);
			if (stopped) return;
			await serial(drain);
		}
	};
	void poll();

	return ok({
		async entries(query = {}) {
			await serial(drain);
			if (query.id !== undefined) return buffer.filter((entry) => entry.id === query.id);
			return query.last === undefined ? [...buffer] : buffer.slice(-query.last);
		},
		async clear() {
			await serial(drain);
			buffer = [];
		},
		async writeJsonl(path) {
			await serial(drain);
			await writeJsonl(path, buffer);
		},
		stop() {
			stopped = true;
		},
	});
}
