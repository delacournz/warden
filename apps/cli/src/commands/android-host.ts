import type { Driver } from "@delacour/warden-driver/driver.types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

/** What `__android-host` reaches the outside world through; tests inject the driver and an abort signal. */
export type AndroidHostDeps = {
	/** open the device's driver (default: the in-process adb driver `warden ui` used to open per call) */
	openDriver?: (ctx: CommandContext, serial: string) => Promise<Result<Driver, string>>;
	signal?: AbortSignal;
};

type HostOptionValues = { serial?: string; socket?: string; idleTimeout?: string };

const DEFAULT_IDLE_SECONDS = 600;
/** exit code when the device's driver cannot be opened (the `warden ui` engine code) */
const EXIT_ENGINE = 3;

export class AndroidHostCommand extends CliCommand {
	override readonly name = "__android-host";
	override readonly summary = "resident Android driver host behind `warden ui` (internal)";
	override readonly hidden = true;

	constructor(private readonly deps: AndroidHostDeps = {}) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option("--serial <serial>")
			.option("--socket <path>")
			.option("--idle-timeout <seconds>")
			.action(async (opts) => done(await this.host(ctx, this.deps, opts)));
	}

	private readonly defaultOpenDriver = async (ctx: CommandContext, serial: string): Promise<Result<Driver, string>> => {
		const { uiDriverFactory } = await import("../agent-ui/ui-driver");
		const opened = await uiDriverFactory.openAndroidInProcess(ctx, serial, (line) => ctx.err(line));
		return opened.success ? resultFactory.ok(opened.data) : { success: false, error: opened.error.message };
	};

	/** `--idle-timeout` in seconds (fractions allowed; 0 = never). */
	private idleMs(raw: string | undefined): Result<number, string> {
		if (raw === undefined) return resultFactory.ok(DEFAULT_IDLE_SECONDS * 1000);
		const seconds = Number(raw);
		if (!Number.isFinite(seconds) || seconds < 0)
			return { success: false, error: `--idle-timeout: not a number of seconds: ${raw}` };
		return resultFactory.ok(Math.round(seconds * 1000));
	}

	private async host(ctx: CommandContext, deps: AndroidHostDeps, opts: HostOptionValues): Promise<number> {
		const { serial, socket } = opts;
		if (serial === undefined || socket === undefined) {
			output.reportError(ctx, "__android-host", "--serial and --socket are required");
			return 1;
		}
		const idle = this.idleMs(opts.idleTimeout);
		if (!idle.success) {
			output.reportError(ctx, "__android-host", idle.error);
			return 1;
		}
		const opened = await (deps.openDriver ?? this.defaultOpenDriver)(ctx, serial);
		if (!opened.success) {
			output.reportError(ctx, "__android-host", `cannot open ${serial}: ${opened.error}`);
			return EXIT_ENGINE;
		}
		const { DriverServer } = await import("@delacour/warden-device/remote/remote-server");
		let finish: () => void = () => undefined;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const server = await new DriverServer({
			driver: opened.data,
			socketPath: socket,
			idleMs: idle.data,
			alertIn: "android",
			onIdle: () => {
				ctx.err(`warden __android-host: idle for ${idle.data} ms, exiting`);
				finish();
			},
			onShutdown: () => finish(),
			log: (line) => ctx.err(line),
		}).start();
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
}

export const androidHostCommand = new AndroidHostCommand().definition();
