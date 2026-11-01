import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Result } from "@delacour/warden-types/result";
import type { DevtoolsResult, Fetch, Sleep } from "./devtools.types";
import { openDevtoolsFacet } from "./facet";
import { appendJsonl, writeJsonl } from "./jsonl";
import type { DevtoolsDevice } from "./session";

const DEFAULT_IDLE_MS = 60_000;
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_UNAVAILABLE = 3;

export type CollectorOptions = {
	metroUrl: string;
	device: DevtoolsDevice;
	/** directory that gets `console.jsonl` and `network.jsonl` (created) */
	out: string;
	/** exit after this long without a console line, network entry or reconnect */
	idleMs: number;
	fetch: Fetch;
	WebSocket?: typeof WebSocket;
	sleep?: Sleep;
	/** SIGTERM / SIGINT, as an `AbortSignal` */
	signal?: AbortSignal;
	log?: (line: string) => void;
	includeBodies?: boolean;
};

export type CollectorEnd = { reason: "idle" | "aborted" | "lost" };

export type Collector = {
	/** resolves once the files are flushed and the socket is closed */
	done: Promise<CollectorEnd>;
	/** same as aborting the signal; idempotent */
	stop: () => void;
};

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The process side of `warden ui logs start`: attach console and network capture to the running app and append
 * what they see to `<out>/console.jsonl` and `<out>/network.jsonl`, until the app has been quiet for `idleMs`
 * (between one and two windows after the last activity), the signal aborts, or the app is gone for good.
 */
export async function startCollector(o: CollectorOptions): Promise<DevtoolsResult<Collector>> {
	const sleep = o.sleep ?? timerSleep;
	const consolePath = join(o.out, "console.jsonl");
	const networkPath = join(o.out, "network.jsonl");
	try {
		await mkdir(o.out, { recursive: true });
		await writeJsonl(consolePath, []);
		await writeJsonl(networkPath, []);
	} catch (error) {
		return { success: false, error: { code: "io_failed", message: `cannot write to ${o.out}: ${String(error)}` } };
	}

	let activity = 0;
	let writes: Promise<unknown> = Promise.resolve();
	const append = (path: string, row: unknown) => {
		activity++;
		writes = writes
			.then(() => appendJsonl(path, [row]))
			.catch((error) => o.log?.(`collector: write failed: ${String(error)}`));
	};

	const opened = await openDevtoolsFacet({
		env: { metroUrl: o.metroUrl },
		device: o.device,
		fetch: o.fetch,
		WebSocket: o.WebSocket,
		log: o.log,
		sleep,
		includeBodies: o.includeBodies,
		consoleSink: (line) => append(consolePath, line),
		networkSink: (entry) => append(networkPath, entry),
	});
	if (!opened.success) return opened;
	const facet = opened.data;

	let finish: (end: CollectorEnd) => void = () => undefined;
	let ended = false;
	const done = new Promise<CollectorEnd>((resolve) => {
		finish = (end) => {
			if (ended) return;
			ended = true;
			facet.close();
			void writes.then(() => resolve(end));
		};
	});

	facet.on("reconnected", () => {
		activity++;
	});
	facet.on("lost", () => finish({ reason: "lost" }));
	const abort = () => finish({ reason: "aborted" });
	if (o.signal?.aborted) abort();
	o.signal?.addEventListener("abort", abort, { once: true });

	void (async () => {
		while (!ended) {
			const before = activity;
			await sleep(o.idleMs);
			if (!ended && activity === before) finish({ reason: "idle" });
		}
	})();

	return ok({ done, stop: abort });
}

export type CollectorArgs = {
	metroUrl: string;
	out: string;
	idleMs: number;
	device: DevtoolsDevice;
	includeBodies: boolean;
};

const VALUE_FLAGS = ["--metro", "--out", "--idle-ms", "--device-name", "--logical-device-id", "--app-id"] as const;

/** Splits argv into value flags and the `--include-bodies` switch; unknown flags and missing values are errors. */
function scanCollectorFlags(argv: readonly string[]): Result<{ values: Map<string, string>; includeBodies: boolean }> {
	const values = new Map<string, string>();
	let includeBodies = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] ?? "";
		if (flag === "--include-bodies") {
			includeBodies = true;
			continue;
		}
		if (!(VALUE_FLAGS as readonly string[]).includes(flag))
			return { success: false, error: `unknown argument ${flag}` };
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return { success: false, error: `${flag} needs a value` };
		values.set(flag, value);
		i++;
	}
	return ok({ values, includeBodies });
}

/** The device filter named by `--device-name`, `--logical-device-id` and `--app-id`. */
function deviceOf(values: ReadonlyMap<string, string>): DevtoolsDevice {
	const device: DevtoolsDevice = {};
	const deviceName = values.get("--device-name");
	const logicalDeviceId = values.get("--logical-device-id");
	const appId = values.get("--app-id");
	if (deviceName) device.deviceName = deviceName;
	if (logicalDeviceId) device.logicalDeviceId = logicalDeviceId;
	if (appId) device.appId = appId;
	return device;
}

/** `--metro <url> --out <dir> [--idle-ms n] [--device-name s] [--logical-device-id s] [--app-id s] [--include-bodies]` */
export function parseCollectorArgv(argv: readonly string[]): Result<CollectorArgs> {
	const scanned = scanCollectorFlags(argv);
	if (!scanned.success) return scanned;
	const { values, includeBodies } = scanned.data;
	const metroUrl = values.get("--metro");
	const out = values.get("--out");
	if (!metroUrl) return { success: false, error: "--metro <url> is required" };
	if (!out) return { success: false, error: "--out <dir> is required" };
	const idleText = values.get("--idle-ms");
	const idleMs = idleText === undefined ? DEFAULT_IDLE_MS : Number(idleText);
	if (!Number.isInteger(idleMs) || idleMs <= 0)
		return { success: false, error: "--idle-ms must be a positive whole number" };
	return ok({ metroUrl, out, idleMs, device: deviceOf(values), includeBodies });
}

export type RunCollectorDeps = {
	fetch: Fetch;
	WebSocket?: typeof WebSocket;
	sleep?: Sleep;
	signal?: AbortSignal;
	log?: (line: string) => void;
};

/**
 * Run a collector from CLI arguments and wait for it. Exit code: 0 when it ended (idle, signal, app gone),
 * 3 when there is no dev client to attach to (`devtools_unavailable`), 1 for bad arguments or anything else.
 */
export async function runCollector(argv: readonly string[], deps: RunCollectorDeps): Promise<number> {
	const log = deps.log ?? (() => undefined);
	const args = parseCollectorArgv(argv);
	if (!args.success) {
		log(`ui-collect: ${args.error}`);
		return EXIT_USAGE;
	}
	const started = await startCollector({ ...args.data, ...deps });
	if (!started.success) {
		log(`ui-collect: ${started.error.code}: ${started.error.message}`);
		return started.error.code === "devtools_unavailable" ? EXIT_UNAVAILABLE : EXIT_USAGE;
	}
	const end = await started.data.done;
	log(`ui-collect: ended (${end.reason})`);
	return EXIT_OK;
}
