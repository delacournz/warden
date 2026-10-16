import { memoryReadFrom } from "../batch/results.testing";
import type { ReadySpec } from "../batch/serve";
import type { MetroOwner } from "../metro";
import type { BatchDeps, KillSignal, ProcHandle, SpawnOptions } from "./batch";

export type Spawned = { cmd: string[]; opts: SpawnOptions; kills: KillSignal[]; finish: (code: number) => void };

export type Harness = {
	deps: BatchDeps;
	spawned: Spawned[];
	jobs: () => Spawned[];
	/** per-device `setup` spawns */
	setups: () => Spawned[];
	serve: () => Spawned | undefined;
	/** the run's own Metro */
	metro: () => Spawned | undefined;
	/** armed `after` timers (job timeouts): call `fire` to expire one */
	timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
	/** every `every` interval (heartbeats, the grid's redraw, the flow poller): call `fn` to fire one tick */
	tickers: Array<{ ms: number; fn: () => void; stopped: boolean }>;
	/** every Metro probe: `<port> <projectRoot>` */
	metroProbes: string[];
	prewarmed: string[];
	files: Map<string, string>;
	dirs: string[];
	events: string[];
	signals: Map<string, () => void>;
	probes: ReadySpec[];
	terminal: string[];
	/** every failure screenshot requested: `<platform> <udid> <path>` */
	shots: string[];
	/** every `slim` request: the udid */
	slimmed: string[];
	/** every warm-up `connect`: the udid */
	warmed: string[];
	/** every warm helper stopped: the udid */
	warmClosed: string[];
};

/**
 * Fake effects: jobs exit on their own with `exitCodes[WARDEN_JOB]` (default 0) unless `manual`;
 * serve (a `group` spawn) runs until killed; `probe` answers from `ready()`.
 */
export function harness(
	opts: {
		exitCodes?: Record<string, number>;
		manual?: boolean;
		ready?: () => boolean;
		isTTY?: boolean;
		serveExitsOnKill?: boolean;
		/** overrides `exitCodes`: the exit code for one job spawn, from its env */
		exitCodeFor?: (env: Record<string, string | undefined>) => number;
		/** the failure-screenshot capture: "fail" resolves false, "throw" rejects */
		screenshot?: "ok" | "fail" | "throw";
		/** the `slim` effect: "fail" resolves an error */
		slim?: "ok" | "fail";
		/** who the Metro probe finds on the leased port (default: this project's Metro) */
		metroOwner?: MetroOwner;
		/** the prewarm outcome: "fail" = the bundle does not build */
		prewarm?: "ok" | "fail";
		/** the warm-up helper: "fail" = cannot connect, "snapshot-fail" = connects but cannot snapshot (default "ok") */
		warm?: "ok" | "fail" | "snapshot-fail";
		/** `bun` on PATH (default `/usr/bin/bun`; null = not installed) */
		bun?: string | null;
		/** where `@delacour/warden-e2e/preload` resolves (default under `/proj/node_modules`; null = not installed) */
		preload?: string | null;
	} = {}
): Harness {
	const h: Harness = {
		spawned: [],
		jobs: () => h.spawned.filter((s) => s.opts.job),
		setups: () => h.spawned.filter((s) => s.opts.setup),
		serve: () => h.spawned.find((s) => s.opts.group && !s.opts.job && !s.opts.metro),
		metro: () => h.spawned.find((s) => s.opts.metro),
		files: new Map(),
		dirs: [],
		events: [],
		signals: new Map(),
		probes: [],
		terminal: [],
		shots: [],
		slimmed: [],
		warmed: [],
		warmClosed: [],
		timers: [],
		tickers: [],
		metroProbes: [],
		prewarmed: [],
		deps: {
			pid: 777,
			isPortFree: async () => true,
			spawn: (cmd, spawnOpts): ProcHandle => {
				let resolveExit: (code: number) => void = () => {};
				const exited = new Promise<number>((resolve) => {
					resolveExit = resolve;
				});
				const entry: Spawned = { cmd, opts: spawnOpts, kills: [], finish: (code) => resolveExit(code) };
				h.spawned.push(entry);
				const job = spawnOpts.env.WARDEN_JOB;
				const daemon = spawnOpts.metro ? "metro" : spawnOpts.group && !spawnOpts.job ? "serve" : undefined;
				h.events.push(
					daemon ? `${daemon}:start` : spawnOpts.setup ? `setup:${spawnOpts.env.WARDEN_UDID}` : `job:${job}`
				);
				if (!daemon && !opts.manual)
					queueMicrotask(() => resolveExit(opts.exitCodeFor?.(spawnOpts.env) ?? opts.exitCodes?.[job ?? ""] ?? 0));
				return {
					exited,
					kill: (signal) => {
						entry.kills.push(signal);
						h.events.push(`${daemon ?? `job:${job}`}:${signal}`);
						if (daemon && opts.serveExitsOnKill !== false) resolveExit(143);
					},
				};
			},
			probe: async (spec) => {
				h.probes.push(spec);
				return opts.ready ? opts.ready() : true;
			},
			sleep: () => Bun.sleep(0),
			record: async (udid, path) => {
				h.events.push(`record:${udid}:${path}`);
				return {
					startedAt: 1_000_500,
					stop: async () => {
						h.events.push(`record-stop:${udid}`);
						return 0;
					},
				};
			},
			screenshot: async (platform, udid, path) => {
				h.shots.push(`${platform} ${udid} ${path}`);
				if (opts.screenshot === "throw") throw new Error("no device");
				return opts.screenshot !== "fail";
			},
			slim: async (udid) => {
				h.slimmed.push(udid);
				h.events.push(`slim:${udid}`);
				return opts.slim === "fail" ? { success: false, error: "not booted" } : { success: true, data: ["a", "b"] };
			},
			writeFile: async (path, data) => {
				h.files.set(path, data);
			},
			readFile: async (path) => {
				const data = h.files.get(path);
				if (data === undefined) throw new Error(`ENOENT: ${path}`);
				return data;
			},
			readFrom: (path, offset) => memoryReadFrom(h.files)(path, offset),
			mkdir: async (dir) => {
				h.dirs.push(dir);
			},
			newId: () => "b1",
			terminal: { isTTY: opts.isTTY ?? false, columns: 80, write: (data) => h.terminal.push(data) },
			onSignal: (signal, handler) => {
				h.signals.set(signal, handler);
				return () => h.signals.delete(signal);
			},
			every: (ms, fn) => {
				const ticker = { ms, fn, stopped: false };
				h.tickers.push(ticker);
				return () => {
					ticker.stopped = true;
				};
			},
			after: (ms, fn) => {
				const timer = { ms, fire: fn, cancelled: false };
				h.timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
			metroProbe: async (port, projectRoot) => {
				h.metroProbes.push(`${port} ${projectRoot}`);
				return opts.metroOwner ?? { kind: "ours" };
			},
			which: (cmd) => (cmd === "bun" ? (opts.bun === undefined ? "/usr/bin/bun" : opts.bun) : null),
			resolveModule: (specifier) => {
				if (opts.preload === null) throw new Error(`Cannot find package '${specifier}'`);
				return opts.preload ?? "/proj/node_modules/@delacour/warden-e2e/src/preload.ts";
			},
			helperDir: () => "/opt/warden",
			warmConnect: () => async (udid) => {
				h.warmed.push(udid);
				h.events.push(`warm:${udid}`);
				if (opts.warm === "fail") return { success: false, error: "helper did not start" };
				return {
					success: true,
					data: {
						socketPath: `/tmp/warden-simd-${udid}.sock`,
						snapshot: async () =>
							opts.warm === "snapshot-fail" ? { success: false, error: "AX denied" } : { success: true, data: null },
						close: async () => {
							h.warmClosed.push(udid);
							h.events.push(`warm-close:${udid}`);
						},
					},
				};
			},
			prewarm: async (url, platform) => {
				h.prewarmed.push(`${platform} ${url}`);
				return opts.prewarm === "fail"
					? { success: false, error: "Metro could not build the ios bundle (HTTP 500): SyntaxError" }
					: { success: true, data: { bundled: true } };
			},
		},
	};
	return h;
}
