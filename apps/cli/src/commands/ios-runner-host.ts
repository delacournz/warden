import { ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { createRunnerBuild } from "../ios-runner/build-port";
import { startProxy } from "../ios-runner/proxy";
import { devicectlList, type RouteDeps } from "../ios-runner/route";
import { removeServedIdentity, writeServedIdentity } from "../ios-runner/served-identity";
import { type SessionDeps, type SessionEnd, startSession } from "../ios-runner/session";
import type { RunnerBuildPort, RunnerFault, SpawnRunner } from "../ios-runner/types";
import { reportError } from "../output";

/** What `__ios-runner-host` reaches the outside world through; tests inject all of it. */
export type IosRunnerHostDeps = {
	build?: RunnerBuildPort;
	spawn?: SpawnRunner;
	route?: RouteDeps;
	after?: (ms: number, fn: () => void) => () => void;
	/** how often the idle clock is looked at (ms) */
	pollMs?: number;
	signal?: AbortSignal;
};

type HostOptionValues = { udid?: string; socket?: string; idleTimeout?: string };

const DEFAULT_IDLE_SECONDS = 600;
/** the runner outlives a vanished host by this long past the host's own idle timeout, then exits by itself */
const RUNNER_IDLE_MARGIN_SECONDS = 120;
/** exit code when the runner cannot be built or started (the `warden ui` engine code) */
const EXIT_ENGINE = 3;

/** `--idle-timeout` in seconds (fractions allowed; 0 = never). */
function idleMs(raw: string | undefined): Result<number, string> {
	if (raw === undefined) return ok(DEFAULT_IDLE_SECONDS * 1000);
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0)
		return { success: false, error: `--idle-timeout: not a number of seconds: ${raw}` };
	return ok(Math.round(seconds * 1000));
}

const defaultSpawn: SpawnRunner = (cmd, env) => {
	const proc = Bun.spawn([...cmd], {
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: (signal) => proc.kill(signal) };
};

const defaultAfter = (ms: number, fn: () => void): (() => void) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};

/** The `fatal` event (the wire shape of `simd-protocol.ts`) for a classified fault, one JSON line. */
export function fatalLine(code: string, message: string): string {
	return JSON.stringify({ event: "fatal", error: { code, message, retryable: false } });
}

export function faultCode(fault: RunnerFault): string {
	return `E_${fault.kind.toUpperCase()}`;
}

async function host(ctx: CommandContext, deps: IosRunnerHostDeps, opts: HostOptionValues): Promise<number> {
	const { udid, socket } = opts;
	if (udid === undefined || socket === undefined) {
		reportError(ctx, "__ios-runner-host", "--udid and --socket are required");
		return 1;
	}
	const idle = idleMs(opts.idleTimeout);
	if (!idle.success) {
		reportError(ctx, "__ios-runner-host", idle.error);
		return 1;
	}
	const die = (code: string, message: string): number => {
		ctx.out(fatalLine(code, message));
		reportError(ctx, "__ios-runner-host", `${code}: ${message}`);
		return EXIT_ENGINE;
	};
	// a leftover file from an earlier host must never vouch for this one
	removeServedIdentity(socket);
	const built = await (deps.build ?? createRunnerBuild(ctx)).ensure({ udid, env: ctx.env });
	if (!built.success) return die(built.error.code, built.error.message);

	const route: RouteDeps = deps.route ?? {
		list: devicectlList({ exec: ctx.exec }),
		sleep: (ms) => Bun.sleep(ms),
		now: () => Date.now(),
	};
	const after = deps.after ?? defaultAfter;
	const sessionDeps: SessionDeps = { spawn: deps.spawn ?? defaultSpawn, route, after, log: (line) => ctx.err(line) };
	const runnerIdle = idle.data === 0 ? 0 : Math.round(idle.data / 1000) + RUNNER_IDLE_MARGIN_SECONDS;
	const started = await startSession(sessionDeps, { udid, artifacts: built.data, runnerIdleSeconds: runnerIdle });
	if (!started.success) return die(faultCode(started.error), started.error.message);
	const session = started.data;

	const proxy = await startProxy({
		socketPath: socket,
		target: () => session.address,
		now: () => Date.now(),
		log: (line) => ctx.err(line),
	});
	if (!proxy.success) {
		await session.stop();
		return die("E_PROXY", proxy.error);
	}

	let finish: (end: SessionEnd) => void = () => undefined;
	const finished = new Promise<SessionEnd>((resolve) => {
		finish = resolve;
	});
	void session.ended.then(finish);
	const stop = (): void => finish({ kind: "clean" });
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	deps.signal?.addEventListener("abort", stop, { once: true });
	const poll = setInterval(() => {
		if (idle.data > 0 && proxy.data.connections() === 0 && Date.now() - proxy.data.lastActivity() >= idle.data) {
			ctx.err(`warden __ios-runner-host: idle for ${idle.data} ms, exiting`);
			finish({ kind: "clean" });
		}
	}, deps.pollMs ?? 1000);

	// which build this host serves: clients replace a host whose runner differs from the current sources
	writeServedIdentity(socket, built.data.derivedData);
	// the one stdout line of a healthy host: the spawner (`helper.ts` `watchStart`) connects the moment it reads it
	ctx.out(JSON.stringify({ event: "ready", socket, pid: process.pid }));
	const end = await finished;
	clearInterval(poll);
	process.off("SIGTERM", stop);
	process.off("SIGINT", stop);
	if (end.kind === "fault") {
		ctx.err(`warden __ios-runner-host: ${end.fault.message}`);
		await proxy.data.broadcast(fatalLine(faultCode(end.fault), end.fault.message));
	}
	await session.stop();
	await proxy.data.close();
	removeServedIdentity(socket);
	return end.kind === "fault" ? EXIT_ENGINE : 0;
}

/**
 * `warden __ios-runner-host --udid <udid> --socket <path> [--idle-timeout <s>]`: the resident process behind
 * `warden ui` on a physical iPhone. Builds (or finds) the signed runner, keeps `xcodebuild test-without-building`
 * running it on the phone, and serves the runner's NDJSON wire on a unix socket (proxied to the CoreDevice tunnel)
 * until `shutdown`, SIGTERM, or `--idle-timeout` seconds with no client (default 600). A runner that cannot start
 * prints one `fatal` event on stdout (code `E_DEVICE_LOCKED`, `E_TUNNEL_DOWN`, `E_INSTALL_FAILED`, …) and exits 3; one
 * that dies later sends the same event to connected clients. Spawned and recorded by `agent-ui/helper.ts`
 * (`ensureIosRunner`), never run by hand. While it runs, `<socket>.build.json` names the runner build it serves
 * (`ios-runner/identity.ts`), which is how a client notices that the runner sources changed. Exit 0 ended · 1 bad arguments · 3 runner not started or died.
 */
export function createIosRunnerHostCommand(deps: IosRunnerHostDeps = {}) {
	return defineCommand({
		name: "__ios-runner-host",
		summary: "resident iPhone runner host behind `warden ui` (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd
				.option("--udid <udid>")
				.option("--socket <path>")
				.option("--idle-timeout <seconds>")
				.action(async (opts) => done(await host(ctx, deps, opts)));
		},
	});
}

export const iosRunnerHostCommand = createIosRunnerHostCommand();
