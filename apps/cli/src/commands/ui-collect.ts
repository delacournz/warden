import { collectorRunner } from "@delacour/warden-devtools/collector";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";

/** What `ui-collect` reaches the outside world through; tests inject an abort signal. */
export type UiCollectDeps = {
	signal?: AbortSignal;
};

type CollectOptionValues = {
	metro?: string;
	out?: string;
	idleMs?: string;
	deviceName?: string;
	logicalDeviceId?: string;
	appId?: string;
	includeBodies?: true;
};

export class UiCollectCommand extends CliCommand {
	override readonly name = "ui-collect";
	override readonly summary = "background console + network collector for `warden ui logs start` (internal)";
	override readonly hidden = true;

	constructor(private readonly deps: UiCollectDeps = {}) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option("--metro <url>")
			.option("--out <dir>")
			.option("--idle-ms <n>")
			.option("--device-name <name>")
			.option("--logical-device-id <id>")
			.option("--app-id <id>")
			.option("--include-bodies")
			.action(async (opts) => done(await this.collect(ctx, this.deps, opts)));
	}

	/** The flags back in the form `runCollector` parses. */
	private collectorArgv(opts: CollectOptionValues): string[] {
		const pairs: [string, string | undefined][] = [
			["--metro", opts.metro],
			["--out", opts.out],
			["--idle-ms", opts.idleMs],
			["--device-name", opts.deviceName],
			["--logical-device-id", opts.logicalDeviceId],
			["--app-id", opts.appId],
		];
		return [
			...pairs.flatMap(([flag, value]) => (value === undefined ? [] : [flag, value])),
			...(opts.includeBodies === true ? ["--include-bodies"] : []),
		];
	}

	private collect(ctx: CommandContext, deps: UiCollectDeps, opts: CollectOptionValues): Promise<number> {
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		deps.signal?.addEventListener("abort", stop, { once: true });
		return collectorRunner
			.run(this.collectorArgv(opts), {
				fetch,
				WebSocket,
				signal: controller.signal,
				log: (line) => ctx.err(line),
			})
			.finally(() => {
				process.off("SIGTERM", stop);
				process.off("SIGINT", stop);
			});
	}
}

export const uiCollectCommand = new UiCollectCommand().definition();
