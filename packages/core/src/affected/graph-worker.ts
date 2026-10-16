import { openImportCache } from "./cache";
import { createImportGraph, reachable } from "./graph";
import { type GraphDoc, type GraphRequest, graphDoc, graphRequestSchema } from "./graph-snapshot";

/**
 * Walk the imports reachable from `request.entries` and return them as one table. This is the one
 * place the TypeScript compiler is loaded for a diff run, and it runs in a process of its own
 * (`graph-process.ts`), so the compiler's 90 ms and ~90 MB never reach the CLI.
 */
export async function buildGraphDoc(request: GraphRequest): Promise<GraphDoc> {
	const graph = await createImportGraph({
		platform: request.platform,
		repoRoot: request.repoRoot,
		...(request.fallbackTsconfig !== undefined ? { fallbackTsconfig: request.fallbackTsconfig } : {}),
		...(request.importCachePath !== undefined ? { cache: openImportCache(request.importCachePath) } : {}),
	});
	const reached = reachable(request.entries, graph.imports);
	graph.save();
	return graphDoc(reached.keys(), graph.imports);
}

/** `bun graph-worker.ts '<request json>'` prints the table as JSON. */
if (import.meta.main) {
	const request = graphRequestSchema.parse(JSON.parse(process.argv[2] ?? ""));
	process.stdout.write(JSON.stringify(await buildGraphDoc(request)));
}
