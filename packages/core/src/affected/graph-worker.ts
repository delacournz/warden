import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { importCaches } from "./cache";
import { importGraphs, TYPESCRIPT_UNUSABLE_EXIT } from "./graph";
import { type GraphDoc, type GraphRequest, graphRequestSchema, graphSnapshots } from "./graph-snapshot";

export class GraphWorker {
	/**
	 * Walk the imports reachable from `request.entries` and return them as one table. This is the one
	 * place the TypeScript compiler is loaded for a diff run, and it runs in a process of its own
	 * (`graph-process.ts`), so the compiler's 90 ms and ~90 MB never reach the CLI. An error when there is no usable
	 * compiler (`typescript`: where it is, default `resolveTypescript`).
	 */
	async build(request: GraphRequest, typescript?: (repoRoot: string) => string | undefined): AsyncResult<GraphDoc> {
		const built = await importGraphs.create({
			platform: request.platform,
			repoRoot: request.repoRoot,
			...(request.fallbackTsconfig !== undefined ? { fallbackTsconfig: request.fallbackTsconfig } : {}),
			...(request.importCachePath !== undefined ? { cache: importCaches.open(request.importCachePath) } : {}),
			...(typescript !== undefined ? { typescript } : {}),
		});
		if (!built.success) return built;
		const graph = built.data;
		const reached = importGraphs.reachable(request.entries, graph.imports);
		graph.save();
		return resultFactory.ok(graphSnapshots.doc(reached.keys(), graph.imports));
	}
}

export const graphWorker = new GraphWorker();

/**
 * `bun graph-worker.ts '<request json>'` prints the table as JSON, or the compiler error on stderr with exit
 * `TYPESCRIPT_UNUSABLE_EXIT`. `.then`, not top-level `await`: the compiled binary
 * bundles this module (for `warden __affected-graph`) with `--bytecode`, which emits CommonJS.
 */
if (import.meta.main) {
	const request = graphRequestSchema.parse(JSON.parse(process.argv[2] ?? ""));
	graphWorker.build(request).then((doc) => {
		if (doc.success) process.stdout.write(JSON.stringify(doc.data));
		else {
			process.stderr.write(`${doc.error}\n`);
			process.exitCode = TYPESCRIPT_UNUSABLE_EXIT;
		}
	});
}
