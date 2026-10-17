import { type AsyncResult, ok } from "@delacour/warden-types/result";
import { openImportCache } from "./cache";
import { createImportGraph, reachable, TYPESCRIPT_UNUSABLE_EXIT } from "./graph";
import { type GraphDoc, type GraphRequest, graphDoc, graphRequestSchema } from "./graph-snapshot";

/**
 * Walk the imports reachable from `request.entries` and return them as one table. This is the one
 * place the TypeScript compiler is loaded for a diff run, and it runs in a process of its own
 * (`graph-process.ts`), so the compiler's 90 ms and ~90 MB never reach the CLI. An error when there is no usable
 * compiler (`typescript`: where it is, default `resolveTypescript`).
 */
export async function buildGraphDoc(
	request: GraphRequest,
	typescript?: (repoRoot: string) => string | undefined
): AsyncResult<GraphDoc> {
	const built = await createImportGraph({
		platform: request.platform,
		repoRoot: request.repoRoot,
		...(request.fallbackTsconfig !== undefined ? { fallbackTsconfig: request.fallbackTsconfig } : {}),
		...(request.importCachePath !== undefined ? { cache: openImportCache(request.importCachePath) } : {}),
		...(typescript !== undefined ? { typescript } : {}),
	});
	if (!built.success) return built;
	const graph = built.data;
	const reached = reachable(request.entries, graph.imports);
	graph.save();
	return ok(graphDoc(reached.keys(), graph.imports));
}

/**
 * `bun graph-worker.ts '<request json>'` prints the table as JSON, or the compiler error on stderr with exit
 * `TYPESCRIPT_UNUSABLE_EXIT`. `.then`, not top-level `await`: the compiled binary
 * bundles this module (for `warden __affected-graph`) with `--bytecode`, which emits CommonJS.
 */
if (import.meta.main) {
	const request = graphRequestSchema.parse(JSON.parse(process.argv[2] ?? ""));
	buildGraphDoc(request).then((doc) => {
		if (doc.success) process.stdout.write(JSON.stringify(doc.data));
		else {
			process.stderr.write(`${doc.error}\n`);
			process.exitCode = TYPESCRIPT_UNUSABLE_EXIT;
		}
	});
}
