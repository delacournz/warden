import { runCollector } from "@delacour/warden-e2e/devtools/collector";
import { defineCommand } from "../command";
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

/** The flags back in the form `runCollector` parses. */
function collectorArgv(opts: CollectOptionValues): string[] {
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

function collect(ctx: CommandContext, deps: UiCollectDeps, opts: CollectOptionValues): Promise<number> {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	deps.signal?.addEventListener("abort", stop, { once: true });
	return runCollector(collectorArgv(opts), {
		fetch,
		WebSocket,
		signal: controller.signal,
		log: (line) => ctx.err(line),
	}).finally(() => {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	});
}

/**
 * `warden ui-collect --metro <url> --out <dir> [--idle-ms n] [--device-name s] [--app-id s] [--include-bodies]`:
 * the detached worker behind `warden ui logs start`. Appends the app's console and network to
 * `<dir>/console.jsonl` and `<dir>/network.jsonl` until the app has been quiet for `--idle-ms` (default 60 s), it
 * gets SIGTERM, or the app is gone. Exit 0 ended · 1 bad arguments · 3 no dev client.
 */
export function createUiCollectCommand(deps: UiCollectDeps = {}) {
	return defineCommand({
		name: "ui-collect",
		summary: "background console + network collector for `warden ui logs start` (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd
				.option("--metro <url>")
				.option("--out <dir>")
				.option("--idle-ms <n>")
				.option("--device-name <name>")
				.option("--logical-device-id <id>")
				.option("--app-id <id>")
				.option("--include-bodies")
				.action(async (opts) => done(await collect(ctx, deps, opts)));
		},
	});
}

export const uiCollectCommand = createUiCollectCommand();
