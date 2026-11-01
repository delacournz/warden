import { type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { buildPort } from "../ios-runner/build-port";
import { runnerProxyService } from "../ios-runner/proxy";
import { type RouteDeps, runnerRoute } from "../ios-runner/route";
import { servedIdentity } from "../ios-runner/served-identity";
import { runnerSession, type SessionDeps, type SessionEnd } from "../ios-runner/session";
import type { RunnerBuildPort, RunnerFault, SpawnRunner } from "../ios-runner/types";
import { output } from "../output";

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

export class IosRunnerHostCommand extends CliCommand {
	override readonly name = "__ios-runner-host";
	override readonly summary = "resident iPhone runner host behind `warden ui` (internal)";
	override readonly hidden = true;

	constructor(private readonly deps: IosRunnerHostDeps = {}) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option("--udid <udid>")
			.option("--socket <path>")
			.option("--idle-timeout <seconds>")
			.action(async (opts) => done(await this.host(ctx, this.deps, opts)));
	}

	/** `--idle-timeout` in seconds (fractions allowed; 0 = never). */
	private idleMs(raw: string | undefined): Result<number, string> {
		if (raw === undefined) return resultFactory.ok(DEFAULT_IDLE_SECONDS * 1000);
		const seconds = Number(raw);
		if (!Number.isFinite(seconds) || seconds < 0)
			return { success: false, error: `--idle-timeout: not a number of seconds: ${raw}` };
		return resultFactory.ok(Math.round(seconds * 1000));
	}

	private readonly defaultSpawn: SpawnRunner = (cmd, env) => {
		const proc = Bun.spawn([...cmd], {
			env: { ...process.env, ...env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: (signal) => proc.kill(signal) };
	};

	private readonly defaultAfter = (ms: number, fn: () => void): (() => void) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	};

	/** The `fatal` event (the wire shape of `simd-protocol.ts`) for a classified fault, one JSON line. */
	fatalLine(code: string, message: string): string {
		return JSON.stringify({ event: "fatal", error: { code, message, retryable: false } });
	}

	faultCode(fault: RunnerFault): string {
		return `E_${fault.kind.toUpperCase()}`;
	}

	private async host(ctx: CommandContext, deps: IosRunnerHostDeps, opts: HostOptionValues): Promise<number> {
		const { udid, socket } = opts;
		if (udid === undefined || socket === undefined) {
			output.reportError(ctx, "__ios-runner-host", "--udid and --socket are required");
			return 1;
		}
		const idle = this.idleMs(opts.idleTimeout);
		if (!idle.success) {
			output.reportError(ctx, "__ios-runner-host", idle.error);
			return 1;
		}
		const die = (code: string, message: string): number => {
			ctx.out(this.fatalLine(code, message));
			output.reportError(ctx, "__ios-runner-host", `${code}: ${message}`);
			return EXIT_ENGINE;
		};
		// a leftover file from an earlier host must never vouch for this one
		servedIdentity.removeServedIdentity(socket);
		const built = await (deps.build ?? buildPort.createRunnerBuild(ctx)).ensure({ udid, env: ctx.env });
		if (!built.success) return die(built.error.code, built.error.message);

		const route: RouteDeps = deps.route ?? {
			list: runnerRoute.devicectlList({ exec: ctx.exec }),
			sleep: (ms) => Bun.sleep(ms),
			now: () => Date.now(),
		};
		const after = deps.after ?? this.defaultAfter;
		const sessionDeps: SessionDeps = {
			spawn: deps.spawn ?? this.defaultSpawn,
			route,
			after,
			log: (line) => ctx.err(line),
		};
		const runnerIdle = idle.data === 0 ? 0 : Math.round(idle.data / 1000) + RUNNER_IDLE_MARGIN_SECONDS;
		const started = await runnerSession.startSession(sessionDeps, {
			udid,
			artifacts: built.data,
			runnerIdleSeconds: runnerIdle,
		});
		if (!started.success) return die(this.faultCode(started.error), started.error.message);
		const session = started.data;

		const proxy = await runnerProxyService.startProxy({
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
		servedIdentity.writeServedIdentity(socket, built.data.derivedData);
		// the one stdout line of a healthy host: the spawner (`helper.ts` `watchStart`) connects the moment it reads it
		ctx.out(JSON.stringify({ event: "ready", socket, pid: process.pid }));
		const end = await finished;
		clearInterval(poll);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		if (end.kind === "fault") {
			ctx.err(`warden __ios-runner-host: ${end.fault.message}`);
			await proxy.data.broadcast(this.fatalLine(this.faultCode(end.fault), end.fault.message));
		}
		await session.stop();
		await proxy.data.close();
		servedIdentity.removeServedIdentity(socket);
		return end.kind === "fault" ? EXIT_ENGINE : 0;
	}
}

export const iosRunnerHost = new IosRunnerHostCommand();
export const iosRunnerHostCommand = iosRunnerHost.definition();
