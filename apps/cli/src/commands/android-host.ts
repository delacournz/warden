import { androidTools } from "@delacour/warden-core/providers/android";
import { emulatorDiscoveryDir, emulatorGrpcEndpoint } from "@delacour/warden-core/providers/android-grpc";
import { wardenHome } from "@delacour/warden-core/store";
import { androidStreamService } from "@delacour/warden-e2e/driver/android/stream/android-stream";
import { locateEmud, startEmudStream } from "@delacour/warden-e2e/driver/android/stream/emud";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { StreamService } from "@delacour/warden-e2e/driver/remote/remote-server";
import { ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";
import { currentBuild } from "../update/build-info";

/** What `__android-host` reaches the outside world through; tests inject the driver and an abort signal. */
export type AndroidHostDeps = {
	/** open the device's driver (default: the in-process adb driver `warden ui` used to open per call) */
	openDriver?: (ctx: CommandContext, serial: string) => Promise<Result<Driver, string>>;
	/** the device's `stream.*` (default: the emulator's gRPC frames through `warden-emud`, else `screenrecord`) */
	openStream?: (ctx: CommandContext, serial: string) => StreamService | undefined;
	signal?: AbortSignal;
};

type HostOptionValues = { serial?: string; socket?: string; idleTimeout?: string };

const DEFAULT_IDLE_SECONDS = 600;
/** exit code when the device's driver cannot be opened (the `warden ui` engine code) */
const EXIT_ENGINE = 3;

async function defaultOpenDriver(ctx: CommandContext, serial: string): Promise<Result<Driver, string>> {
	const { openAndroidInProcess } = await import("../agent-ui/ui-driver");
	const opened = await openAndroidInProcess(ctx, serial, (line) => ctx.err(line));
	return opened.success ? ok(opened.data) : { success: false, error: opened.error.message };
}

/**
 * `stream.*` for the device: `warden-emud` (found beside `warden-simd`) on the emulator's gRPC bridge when both are
 * there, `screenrecord` over adb otherwise. Nothing runs until `stream.start`.
 */
function defaultOpenStream(ctx: CommandContext, serial: string): StreamService {
	const emud = locateEmud({ env: ctx.env, wardenHome: wardenHome(ctx.env), version: currentBuild().version });
	const log = (line: string) => ctx.err(`warden __android-host: ${line}`);
	return androidStreamService({
		serial,
		adb: androidTools(ctx.env).adb,
		exec: (cmd) => ctx.exec(cmd),
		spawn: (argv) => {
			const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
			return { stdout: child.stdout, exited: child.exited, kill: () => child.kill() };
		},
		grpcEndpoint: () => {
			const endpoint = emulatorGrpcEndpoint(emulatorDiscoveryDir(ctx.env), serial);
			if (!endpoint.success) {
				log(endpoint.error);
				return undefined;
			}
			const { host, port, token } = endpoint.data;
			return { host, port, token };
		},
		...(emud !== undefined
			? {
					startGrpc: (endpoint, params, path, size) =>
						startEmudStream({
							binary: emud,
							endpoint,
							params,
							path,
							size,
							spawn: (argv, env) => {
								const child = Bun.spawn([...argv], {
									stdin: "pipe",
									stdout: "pipe",
									stderr: "inherit",
									env: { ...process.env, ...env },
								});
								return { stdin: child.stdin, stdout: child.stdout, exited: child.exited, kill: () => child.kill() };
							},
						}),
				}
			: {}),
		log,
	});
}

/** `--idle-timeout` in seconds (fractions allowed; 0 = never). */
function idleMs(raw: string | undefined): Result<number, string> {
	if (raw === undefined) return ok(DEFAULT_IDLE_SECONDS * 1000);
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0)
		return { success: false, error: `--idle-timeout: not a number of seconds: ${raw}` };
	return ok(Math.round(seconds * 1000));
}

async function host(ctx: CommandContext, deps: AndroidHostDeps, opts: HostOptionValues): Promise<number> {
	const { serial, socket } = opts;
	if (serial === undefined || socket === undefined) {
		reportError(ctx, "__android-host", "--serial and --socket are required");
		return 1;
	}
	const idle = idleMs(opts.idleTimeout);
	if (!idle.success) {
		reportError(ctx, "__android-host", idle.error);
		return 1;
	}
	const opened = await (deps.openDriver ?? defaultOpenDriver)(ctx, serial);
	if (!opened.success) {
		reportError(ctx, "__android-host", `cannot open ${serial}: ${opened.error}`);
		return EXIT_ENGINE;
	}
	const { serveDriver } = await import("@delacour/warden-e2e/driver/remote/remote-server");
	let finish: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stream = (deps.openStream ?? defaultOpenStream)(ctx, serial);
	const server = await serveDriver({
		driver: opened.data,
		...(stream !== undefined ? { stream } : {}),
		socketPath: socket,
		idleMs: idle.data,
		alertIn: "android",
		onIdle: () => {
			ctx.err(`warden __android-host: idle for ${idle.data} ms, exiting`);
			finish();
		},
		onShutdown: () => finish(),
		log: (line) => ctx.err(line),
	});
	process.once("SIGTERM", finish);
	process.once("SIGINT", finish);
	deps.signal?.addEventListener("abort", finish, { once: true });
	// the one stdout line: the spawner (`helper.ts` `watchStart`) connects the moment it reads it
	ctx.out(JSON.stringify({ event: "ready", socket, pid: process.pid }));
	await finished;
	process.off("SIGTERM", finish);
	process.off("SIGINT", finish);
	await server.stop();
	return 0;
}

/**
 * `warden __android-host --serial <s> --socket <path> [--idle-timeout <s>]`: the resident process behind `warden ui`
 * on Android. Opens the emulator's driver once (adb shell, `warden-uiad`, animation scales off) and serves it on a
 * unix socket (`@delacour/warden-e2e/driver/remote`) until `shutdown`, SIGTERM, or `--idle-timeout` seconds with no
 * client (default 600); then closes the driver, which puts the animation scales back. Spawned and recorded by
 * `agent-ui/helper.ts` (`ensureAndroidHost`), never run by hand. Exit 0 ended · 1 bad arguments · 3 no driver.
 */
export function createAndroidHostCommand(deps: AndroidHostDeps = {}) {
	return defineCommand({
		name: "__android-host",
		summary: "resident Android driver host behind `warden ui` (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd
				.option("--serial <serial>")
				.option("--socket <path>")
				.option("--idle-timeout <seconds>")
				.action(async (opts) => done(await host(ctx, deps, opts)));
		},
	});
}

export const androidHostCommand = createAndroidHostCommand();
