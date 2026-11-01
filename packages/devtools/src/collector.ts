import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { DevtoolsResult, Fetch, Sleep } from "./devtools.types";
import { devtoolsFacetOpener } from "./facet";
import { jsonl } from "./jsonl";
import type { DevtoolsDevice } from "./session";
import { timer } from "./timer";

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

export type CollectorArgs = {
	metroUrl: string;
	out: string;
	idleMs: number;
	device: DevtoolsDevice;
	includeBodies: boolean;
};

export type RunCollectorDeps = {
	fetch: Fetch;
	WebSocket?: typeof WebSocket;
	sleep?: Sleep;
	signal?: AbortSignal;
	log?: (line: string) => void;
};

const VALUE_FLAGS = ["--metro", "--out", "--idle-ms", "--device-name", "--logical-device-id", "--app-id"] as const;

/** One running collector: the capture files, the activity counter and the end condition. */
class CollectorProcess {
	private readonly sleep: Sleep;
	private readonly consolePath: string;
	private readonly networkPath: string;
	private activity = 0;
	private writes: Promise<unknown> = Promise.resolve();
	private ended = false;
	private finish: (end: CollectorEnd) => void = () => undefined;

	constructor(private readonly o: CollectorOptions) {
		this.sleep = o.sleep ?? timer.sleep;
		this.consolePath = join(o.out, "console.jsonl");
		this.networkPath = join(o.out, "network.jsonl");
	}

	async start(): Promise<DevtoolsResult<Collector>> {
		const { o } = this;
		try {
			await mkdir(o.out, { recursive: true });
			await jsonl.write(this.consolePath, []);
			await jsonl.write(this.networkPath, []);
		} catch (error) {
			return { success: false, error: { code: "io_failed", message: `cannot write to ${o.out}: ${String(error)}` } };
		}

		const opened = await devtoolsFacetOpener.open({
			env: { metroUrl: o.metroUrl },
			device: o.device,
			fetch: o.fetch,
			WebSocket: o.WebSocket,
			log: o.log,
			sleep: this.sleep,
			includeBodies: o.includeBodies,
			consoleSink: (line) => this.append(this.consolePath, line),
			networkSink: (entry) => this.append(this.networkPath, entry),
		});
		if (!opened.success) return opened;
		const facet = opened.data;

		const done = new Promise<CollectorEnd>((resolve) => {
			this.finish = (end) => {
				if (this.ended) return;
				this.ended = true;
				facet.close();
				void this.writes.then(() => resolve(end));
			};
		});

		facet.on("reconnected", () => {
			this.activity++;
		});
		facet.on("lost", () => this.finish({ reason: "lost" }));
		const abort = () => this.finish({ reason: "aborted" });
		if (o.signal?.aborted) abort();
		o.signal?.addEventListener("abort", abort, { once: true });

		void this.watchIdle();

		return resultFactory.ok({ done, stop: abort });
	}

	private append(path: string, row: unknown): void {
		this.activity++;
		this.writes = this.writes
			.then(() => jsonl.append(path, [row]))
			.catch((error) => this.o.log?.(`collector: write failed: ${String(error)}`));
	}

	private async watchIdle(): Promise<void> {
		while (!this.ended) {
			const before = this.activity;
			await this.sleep(this.o.idleMs);
			if (!this.ended && this.activity === before) this.finish({ reason: "idle" });
		}
	}
}

/** Parses `warden ui collect` argv. Use the shared {@link collectorArgv} singleton. */
export class CollectorArgvParser {
	/** `--metro <url> --out <dir> [--idle-ms n] [--device-name s] [--logical-device-id s] [--app-id s] [--include-bodies]` */
	parse(argv: readonly string[]): Result<CollectorArgs> {
		const scanned = this.scanFlags(argv);
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
		return resultFactory.ok({ metroUrl, out, idleMs, device: this.deviceOf(values), includeBodies });
	}

	/** Splits argv into value flags and the `--include-bodies` switch; unknown flags and missing values are errors. */
	private scanFlags(argv: readonly string[]): Result<{ values: Map<string, string>; includeBodies: boolean }> {
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
		return resultFactory.ok({ values, includeBodies });
	}

	/** The device filter named by `--device-name`, `--logical-device-id` and `--app-id`. */
	private deviceOf(values: ReadonlyMap<string, string>): DevtoolsDevice {
		const device: DevtoolsDevice = {};
		const deviceName = values.get("--device-name");
		const logicalDeviceId = values.get("--logical-device-id");
		const appId = values.get("--app-id");
		if (deviceName) device.deviceName = deviceName;
		if (logicalDeviceId) device.logicalDeviceId = logicalDeviceId;
		if (appId) device.appId = appId;
		return device;
	}
}

export const collectorArgv = new CollectorArgvParser();

/** Starts and runs collectors. Use the shared {@link collectorRunner} singleton. */
export class CollectorRunner {
	/**
	 * The process side of `warden ui logs start`: attach console and network capture to the running app and append
	 * what they see to `<out>/console.jsonl` and `<out>/network.jsonl`, until the app has been quiet for `idleMs`
	 * (between one and two windows after the last activity), the signal aborts, or the app is gone for good.
	 */
	start(o: CollectorOptions): Promise<DevtoolsResult<Collector>> {
		return new CollectorProcess(o).start();
	}

	/**
	 * Run a collector from CLI arguments and wait for it. Exit code: 0 when it ended (idle, signal, app gone),
	 * 3 when there is no dev client to attach to (`devtools_unavailable`), 1 for bad arguments or anything else.
	 */
	async run(argv: readonly string[], deps: RunCollectorDeps): Promise<number> {
		const log = deps.log ?? (() => undefined);
		const args = collectorArgv.parse(argv);
		if (!args.success) {
			log(`ui-collect: ${args.error}`);
			return EXIT_USAGE;
		}
		const started = await this.start({ ...args.data, ...deps });
		if (!started.success) {
			log(`ui-collect: ${started.error.code}: ${started.error.message}`);
			return started.error.code === "devtools_unavailable" ? EXIT_UNAVAILABLE : EXIT_USAGE;
		}
		const end = await started.data.done;
		log(`ui-collect: ended (${end.reason})`);
		return EXIT_OK;
	}
}

export const collectorRunner = new CollectorRunner();
