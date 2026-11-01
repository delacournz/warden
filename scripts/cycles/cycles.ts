import { dirname, join, normalize } from "node:path";

/** Pseudo-cluster for files directly under `src/`; excluded from the graph. */
export const ROOT_CLUSTER = "root";

export type ClusterGraph = Map<string, Set<string>>;

/** Cluster of a path relative to `src/`: its top-level directory, or `root` for a top-level file. */
export function clusterOf(relPath: string): string {
	const i = relPath.indexOf("/");
	return i === -1 ? ROOT_CLUSTER : relPath.slice(0, i);
}

const SPECIFIER_PATTERNS: RegExp[] = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*["']([^"']+)["']/g,
	/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

/** Every module specifier a source text imports (static, side-effect, dynamic, require); comments ignored. */
export function importSpecifiers(rawSource: string): string[] {
	const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
	const found = new Set<string>();
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const m of source.matchAll(pattern)) {
			const spec = m[1];
			if (spec !== undefined) found.add(spec);
		}
	}
	return [...found];
}

function isTestFile(relPath: string): boolean {
	return /\.test\.tsx?$/.test(relPath);
}

/** Clusters `relPath`'s source imports, ignoring externals, escapes out of `src/`, root files and self-edges. */
function clusterEdges(relPath: string, source: string, from: string): string[] {
	const targets: string[] = [];
	for (const spec of importSpecifiers(source)) {
		if (!spec.startsWith(".")) continue;
		const target = normalize(join(dirname(relPath), spec));
		if (target.startsWith("..")) continue;
		const to = clusterOf(target);
		if (to !== ROOT_CLUSTER && to !== from) targets.push(to);
	}
	return targets;
}

/**
 * Cluster-level import graph. `files` maps `src/`-relative path to source text. Relative imports only;
 * test files, root files, self-edges and externals are ignored.
 */
export function buildClusterGraph(files: ReadonlyMap<string, string>): ClusterGraph {
	const graph: ClusterGraph = new Map();
	for (const [relPath, source] of files) {
		if (isTestFile(relPath)) continue;
		const from = clusterOf(relPath);
		if (from === ROOT_CLUSTER) continue;
		const edges = graph.get(from) ?? new Set<string>();
		graph.set(from, edges);
		for (const to of clusterEdges(relPath, source, from)) edges.add(to);
	}
	return graph;
}

/** Direct two-way cluster dependencies (`a <-> b`), the usual shape of a cycle; sorted. */
export function mutualPairs(graph: ClusterGraph): string[] {
	const pairs: string[] = [];
	for (const [from, tos] of graph) {
		for (const to of tos) if (from < to && graph.get(to)?.has(from)) pairs.push(`${from} <-> ${to}`);
	}
	return pairs.sort();
}

type Tarjan = {
	graph: ClusterGraph;
	counter: number;
	index: Map<string, number>;
	low: Map<string, number>;
	onStack: Set<string>;
	stack: string[];
	cycles: string[][];
};

function lowerLow(t: Tarjan, node: string, via: number | undefined): void {
	t.low.set(node, Math.min(t.low.get(node) ?? 0, via ?? 0));
}

/** Pops the finished component off the stack; it is a cycle when it holds more than one cluster. */
function popComponent(t: Tarjan, node: string): void {
	const component: string[] = [];
	for (;;) {
		const top = t.stack.pop();
		if (top === undefined) break;
		t.onStack.delete(top);
		component.push(top);
		if (top === node) break;
	}
	if (component.length > 1) t.cycles.push(component.sort());
}

function visit(t: Tarjan, node: string): void {
	t.index.set(node, t.counter);
	t.low.set(node, t.counter);
	t.counter++;
	t.stack.push(node);
	t.onStack.add(node);
	for (const next of t.graph.get(node) ?? []) {
		if (!t.index.has(next)) {
			visit(t, next);
			lowerLow(t, node, t.low.get(next));
		} else if (t.onStack.has(next)) {
			lowerLow(t, node, t.index.get(next));
		}
	}
	if (t.low.get(node) === t.index.get(node)) popComponent(t, node);
}

/** Strongly connected components with more than one cluster (Tarjan), each sorted, list sorted. */
export function findCycles(graph: ClusterGraph): string[][] {
	const t: Tarjan = {
		graph,
		counter: 0,
		index: new Map(),
		low: new Map(),
		onStack: new Set(),
		stack: [],
		cycles: [],
	};
	for (const node of [...graph.keys()].sort()) if (!t.index.has(node)) visit(t, node);
	return t.cycles.sort((x, y) => x.join().localeCompare(y.join()));
}
