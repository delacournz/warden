import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult, Logger } from "../driver.types";
import { driverError } from "../errors";
import { type ClientOptions, createSimdClient, type RequestOptions, type SimdClient } from "./simd-client";
import { createLineSplitter } from "./simd-protocol";
import { bunSpawn, type SimdProcess, type SimdSpawn, socketTransport } from "./simd-transport";

/**
 * `warden-runner` (the XCUITest server of `native/ios-runner`) on an iOS Simulator, for the ops XCUITest has and the
 * simulator helper does not: today the accessibility audit (A11Y-4). Started lazily on the first request:
 *
 *   build (cached, no signing)  ->  `xcodebuild test-without-building -xctestrun … -destination id=<udid>
 *   -only-testing:…/testServe`  ->  wait for `WARDEN_RUNNER_READY {json}` (the port)  ->  NDJSON over TCP on this Mac
 *
 * The runner outlives the request (the next audit costs the audit only, about 2 s) and is shut down by `close()`.
 * Anything that stops it from starting is a {@link DriverError} the caller turns into a skipped audit, never a failure.
 */

export const READY_PREFIX = "WARDEN_RUNNER_READY";
export const TEST_FILTER = "-only-testing:WardenRunnerUITests/RunnerTests/testServe";
const READY_TIMEOUT_MS = 90_000;
const IDLE_SECONDS = 600;

/** The port in a `WARDEN_RUNNER_READY {json}` line, or undefined for any other line. */
export function parseRunnerReady(line: string): number | undefined {
	const at = line.indexOf(READY_PREFIX);
	if (at < 0) return undefined;
	try {
		const port: unknown = JSON.parse(line.slice(at + READY_PREFIX.length).trim()).port;
		return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

/** The argv that serves the runner on `udid`; `env` carries the `TEST_RUNNER_*` variables `xcodebuild` forwards. */
export function simRunnerArgv(o: { xctestrun: string; udid: string; idleSeconds?: number }): string[] {
	return [
		"env",
		`TEST_RUNNER_WARDEN_RUNNER_UDID=${o.udid}`,
		`TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS=${o.idleSeconds ?? IDLE_SECONDS}`,
		"xcodebuild",
		"test-without-building",
		"-xctestrun",
		o.xctestrun,
		"-destination",
		`id=${o.udid}`,
		TEST_FILTER,
	];
}

export type SimRunnerDeps = {
	udid: string;
	/** a cached simulator runner build (`ensureSimRunnerBuild`), or why there is none */
	ensureBuild(): Promise<Result<{ xctestrun: string }, string>>;
	spawn?: SimdSpawn;
	/** connect to the runner's port (tests inject a fake) */
	connect?: (port: number, options: ClientOptions) => Promise<Result<SimdClient, DriverError>>;
	readyTimeoutMs?: number;
	log?: Logger;
};

export type SimRunner = {
	request(op: string, params?: Record<string, unknown>, opts?: RequestOptions): DriverResult<unknown>;
	close(): Promise<void>;
};

const tcpConnect: NonNullable<SimRunnerDeps["connect"]> = (port, options) =>
	createSimdClient(socketTransport({ tcp: { hostname: "127.0.0.1", port } }), {
		...options,
		maxRespawns: 0,
		shutdownOnClose: true,
	});

async function pump(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
	if (stream === undefined) return;
	const splitter = createLineSplitter();
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const line of splitter.push(value)) onLine(line);
		}
	} catch {
		// a killed process closes its pipes mid-read
	}
}

type Started = { proc: SimdProcess; client: SimdClient };

export function createSimRunner(deps: SimRunnerDeps): SimRunner {
	const spawn = deps.spawn ?? bunSpawn;
	const connect = deps.connect ?? tcpConnect;
	const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
	let starting: Promise<Result<Started, DriverError>> | undefined;

	async function start(): Promise<Result<Started, DriverError>> {
		const built = await deps.ensureBuild();
		if (!built.success) {
			return {
				success: false,
				error: driverError("E_UNSUPPORTED", `the Simulator runner is not available: ${built.error}`),
			};
		}
		const proc = spawn(simRunnerArgv({ xctestrun: built.data.xctestrun, udid: deps.udid }));
		const tail: string[] = [];
		let onPort: (port: number) => void = () => undefined;
		const ready = new Promise<number>((resolve) => {
			onPort = resolve;
		});
		const onLine = (line: string): void => {
			if (line.trim() === "") return;
			tail.push(line);
			if (tail.length > 8) tail.shift();
			const port = parseRunnerReady(line);
			if (port !== undefined) onPort(port);
		};
		void pump(proc.stdout, onLine);
		void pump(proc.stderr, onLine);
		const exited = proc.exited.then(() => "exited" as const).catch(() => "exited" as const);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), readyTimeoutMs);
		});
		const first = await Promise.race([ready, exited, timeout]);
		clearTimeout(timer);
		if (typeof first !== "number") {
			proc.kill();
			const why =
				first === "timeout" ? `did not start within ${readyTimeoutMs / 1000} s` : "exited before it was ready";
			return {
				success: false,
				error: driverError("E_HELPER_CRASHED", `the Simulator runner ${why}: ${tail.slice(-3).join(" | ")}`),
			};
		}
		const client = await connect(first, { ...(deps.log ? { log: deps.log } : {}), defaultTimeoutMs: 30_000 });
		if (!client.success) {
			proc.kill();
			return client;
		}
		return { success: true, data: { proc, client: client.data } };
	}

	return {
		async request(op, params, opts) {
			starting ??= start();
			const started = await starting;
			if (!started.success) {
				starting = undefined;
				return started;
			}
			return started.data.client.request(op, params, opts);
		},
		async close() {
			const current = starting;
			starting = undefined;
			const started = current === undefined ? undefined : await current;
			if (started?.success !== true) return;
			await started.data.client.close();
			const grace = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
			await Promise.race([started.data.proc.exited.catch(() => 0), grace]);
			started.data.proc.kill();
		},
	};
}
