import { TYPESCRIPT_UNUSABLE_EXIT } from "@delacour/warden-core/affected/graph";
import { GRAPH_WORKER_SUBCOMMAND } from "@delacour/warden-core/affected/graph-process";
import type { GraphDoc, GraphRequest } from "@delacour/warden-core/affected/graph-snapshot";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

const SUMMARY = "walk the import graph for `warden affected` and print it as JSON (internal)";

export class AffectedGraphCommand extends CliCommand {
	override readonly name = GRAPH_WORKER_SUBCOMMAND;
	override readonly summary = SUMMARY;
	override readonly hidden = true;

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.argument("<request>", "the graph request, as JSON")
			.action(async (request) => done(await this.walk(ctx, request)));
	}

	/** The request argument as a graph request, or why it is not one. */
	private async parseRequest(raw: string): AsyncResult<GraphRequest> {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return resultFactory.err("the request is not JSON");
		}
		const { graphRequestSchema } = await import("@delacour/warden-core/affected/graph-snapshot");
		const parsed = graphRequestSchema.safeParse(json);
		return parsed.success
			? resultFactory.ok(parsed.data)
			: resultFactory.err(`not a graph request: ${parsed.error.message}`);
	}

	/**
	 * `warden __affected-graph '<request json>'`: the import graph walk of `warden affected`, run in a process of its own so
	 * the TypeScript compiler stays out of the CLI. From source that process is `bun graph-worker.ts`; a compiled binary has
	 * no script on disk, so it runs this subcommand of itself (`graph-process.ts`). Prints the table as one JSON line; no
	 * usable TypeScript compiler is `TYPESCRIPT_UNUSABLE_EXIT` with the reason, which the caller reports as is.
	 */
	async walk(
		ctx: CommandContext,
		raw: string,
		build: (request: GraphRequest) => AsyncResult<GraphDoc> = this.defaultBuild
	): Promise<number> {
		const request = await this.parseRequest(raw);
		if (!request.success) {
			output.reportError(ctx, GRAPH_WORKER_SUBCOMMAND, request.error);
			return 1;
		}
		const doc = await build(request.data);
		if (!doc.success) {
			output.reportError(ctx, GRAPH_WORKER_SUBCOMMAND, doc.error);
			return TYPESCRIPT_UNUSABLE_EXIT;
		}
		ctx.out(JSON.stringify(doc.data));
		return 0;
	}

	/** The walker, imported on use (it loads the compiler). */
	private readonly defaultBuild = async (request: GraphRequest): AsyncResult<GraphDoc> => {
		const { graphWorker } = await import("@delacour/warden-core/affected/graph-worker");
		return graphWorker.build(request);
	};
}

export const affectedGraphCli = new AffectedGraphCommand();
export const affectedGraphCommand = affectedGraphCli.definition();
