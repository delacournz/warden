import { resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import type { DevtoolsResult, NetworkEntry, NetworkQuery, Sleep } from "./devtools.types";
import { jsonl } from "./jsonl";
import { NETWORK_DRAIN_EXPRESSION, networkInstallExpression } from "./network.script";
import type { DevtoolsSession } from "./session";
import { timer } from "./timer";

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

/** Every URL prefix that is the same Metro: its origin plus the loopback aliases of a simulator and an emulator. */
class MetroPrefixes {
	of(metroUrl: string): string[] {
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
}

const metroPrefixes = new MetroPrefixes();

/** Records one session's `fetch` calls into a ring; built by {@link NetworkAttacher}. */
class NetworkRecorder implements NetworkCapture {
	private readonly ring: number;
	private readonly sleep: Sleep;
	private readonly pollMs: number;
	private readonly installExpression: string;
	private buffer: NetworkEntry[] = [];
	private nextId = 1;
	private stopped = false;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly session: DevtoolsSession,
		private readonly options: NetworkOptions
	) {
		this.ring = options.ring ?? DEFAULT_RING;
		this.sleep = options.sleep ?? timer.sleep;
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.installExpression = networkInstallExpression({
			ring: this.ring,
			includeBodies: options.includeBodies ?? false,
			skipPrefixes: options.metroUrl ? metroPrefixes.of(options.metroUrl) : [],
		});
	}

	/** Installs the page wrapper and starts polling; fails when the first install does. */
	async start(): Promise<DevtoolsResult<NetworkCapture>> {
		const first = await this.install();
		if (!first.success) return first;
		this.session.on("reconnected", () => {
			void this.serial(this.install);
		});
		void this.poll();
		return resultFactory.ok(this);
	}

	readonly entries = async (query: NetworkQuery = {}): Promise<NetworkEntry[]> => {
		await this.serial(this.drain);
		if (query.id !== undefined) return this.buffer.filter((entry) => entry.id === query.id);
		return query.last === undefined ? [...this.buffer] : this.buffer.slice(-query.last);
	};

	readonly clear = async (): Promise<void> => {
		await this.serial(this.drain);
		this.buffer = [];
	};

	readonly writeJsonl = async (path: string): Promise<void> => {
		await this.serial(this.drain);
		await jsonl.write(path, this.buffer);
	};

	readonly stop = (): void => {
		this.stopped = true;
	};

	/** one at a time, so a poll and an `entries()` never interleave */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private readonly install = async (): Promise<DevtoolsResult<true>> => {
		const installed = await this.session.evaluate(this.installExpression);
		if (installed.success) return resultFactory.ok(true);
		return { success: false, error: { code: installed.error.code ?? "eval_failed", message: installed.error.message } };
	};

	private take(text: string): void {
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
			const entry: NetworkEntry = { ...parsed.data, id: this.nextId++ };
			this.buffer.push(entry);
			this.options.sink?.(entry);
		}
		if (this.buffer.length > this.ring) this.buffer = this.buffer.slice(this.buffer.length - this.ring);
	}

	private readonly drain = async (): Promise<void> => {
		const drained = await this.session.evaluate(NETWORK_DRAIN_EXPRESSION);
		if (!drained.success) return;
		if (typeof drained.data === "string") this.take(drained.data);
		else if (drained.data === null) await this.install();
	};

	private async poll(): Promise<void> {
		for (;;) {
			await this.sleep(this.pollMs);
			if (this.stopped) return;
			await this.serial(this.drain);
		}
	}
}

/** Starts network capture on a session. Use the shared {@link networkAttacher} singleton. */
export class NetworkAttacher {
	/** Every URL prefix that is the same Metro: its origin plus the loopback aliases of a simulator and an emulator. */
	skipPrefixes(metroUrl: string): string[] {
		return metroPrefixes.of(metroUrl);
	}

	/**
	 * Record the app's `fetch` calls: patch `fetch` inside the page once, then drain its ring on a timer and
	 * whenever a caller asks. A new JS context (reload) loses the wrapper, so it is re-installed on reconnect and
	 * whenever a drain finds it missing; requests made before that are lost.
	 */
	attach(session: DevtoolsSession, options: NetworkOptions = {}): Promise<DevtoolsResult<NetworkCapture>> {
		return new NetworkRecorder(session, options).start();
	}
}

export const networkAttacher = new NetworkAttacher();
