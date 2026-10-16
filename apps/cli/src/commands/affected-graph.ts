import { GRAPH_WORKER_SUBCOMMAND } from "@delacour/warden-core/affected/graph-process";
import type { GraphRequest } from "@delacour/warden-core/affected/graph-snapshot";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

const SUMMARY = "walk the import graph for `warden affected` and print it as JSON (internal)";

/** The request argument as a graph request, or why it is not one. */
async function parseRequest(raw: string): AsyncResult<GraphRequest> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return err("the request is not JSON");
	}
	const { graphRequestSchema } = await import("@delacour/warden-core/affected/graph-snapshot");
	const parsed = graphRequestSchema.safeParse(json);
	return parsed.success ? ok(parsed.data) : err(`not a graph request: ${parsed.error.message}`);
}

/**
 * `warden __affected-graph '<request json>'`: the import graph walk of `warden affected`, run in a process of its own so
 * the TypeScript compiler stays out of the CLI. From source that process is `bun graph-worker.ts`; a compiled binary has
 * no script on disk, so it runs this subcommand of itself (`graph-process.ts`). Prints the table as one JSON line.
 */
async function walk(ctx: CommandContext, raw: string): Promise<number> {
	const request = await parseRequest(raw);
	if (!request.success) {
		reportError(ctx, GRAPH_WORKER_SUBCOMMAND, request.error);
		return 1;
	}
	const { buildGraphDoc } = await import("@delacour/warden-core/affected/graph-worker");
	ctx.out(JSON.stringify(await buildGraphDoc(request.data)));
	return 0;
}

export const affectedGraphCommand = defineCommand({
	name: GRAPH_WORKER_SUBCOMMAND,
	summary: SUMMARY,
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd.argument("<request>", "the graph request, as JSON").action(async (request) => done(await walk(ctx, request)));
	},
});
