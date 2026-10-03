import type { ReadySpec } from "../batch/serve";
import type { BatchDeps, KillSignal, ProcHandle, SpawnOptions } from "./batch";

export type Spawned = { cmd: string[]; opts: SpawnOptions; kills: KillSignal[]; finish: (code: number) => void };

export type Harness = {
	deps: BatchDeps;
	spawned: Spawned[];
	jobs: () => Spawned[];
	serve: () => Spawned | undefined;
	files: Map<string, string>;
	dirs: string[];
	events: string[];
	signals: Map<string, () => void>;
	probes: ReadySpec[];
	terminal: string[];
	/** every failure screenshot requested: `<platform> <udid> <path>` */
	shots: string[];
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
	} = {}
): Harness {
	const h: Harness = {
		spawned: [],
		jobs: () => h.spawned.filter((s) => !s.opts.group),
		serve: () => h.spawned.find((s) => s.opts.group),
		files: new Map(),
		dirs: [],
		events: [],
		signals: new Map(),
		probes: [],
		terminal: [],
		shots: [],
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
				h.events.push(spawnOpts.group ? "serve:start" : `job:${job}`);
				if (!spawnOpts.group && !opts.manual)
					queueMicrotask(() => resolveExit(opts.exitCodeFor?.(spawnOpts.env) ?? opts.exitCodes?.[job ?? ""] ?? 0));
				return {
					exited,
					kill: (signal) => {
						entry.kills.push(signal);
						h.events.push(`${spawnOpts.group ? "serve" : `job:${job}`}:${signal}`);
						if (spawnOpts.group && opts.serveExitsOnKill !== false) resolveExit(143);
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
			writeFile: async (path, data) => {
				h.files.set(path, data);
			},
			readFile: async (path) => {
				const data = h.files.get(path);
				if (data === undefined) throw new Error(`ENOENT: ${path}`);
				return data;
			},
			mkdir: async (dir) => {
				h.dirs.push(dir);
			},
			newId: () => "b1",
			terminal: { isTTY: opts.isTTY ?? false, columns: 80, write: (data) => h.terminal.push(data) },
			onSignal: (signal, handler) => {
				h.signals.set(signal, handler);
				return () => h.signals.delete(signal);
			},
			every: (_ms, _fn) => () => {},
		},
	};
	return h;
}
