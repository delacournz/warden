import { findCycles } from "./cycles";

/** A workspace package as the cycle check sees it. */
export type WorkspacePackage = {
	name: string;
	/** workspace packages named in `dependencies` / `devDependencies` / `peerDependencies` */
	declared: readonly string[];
	/** source text per file, keyed by workspace-relative path (own `src/` only) */
	sources: ReadonlyMap<string, string>;
};

export type PackageGraph = Map<string, Set<string>>;

const WORKSPACE_PREFIX = "@delacour/warden";

/** `@delacour/warden-store/types` → `@delacour/warden-store`; `undefined` for anything that is not a workspace package. */
export function workspacePackageOf(specifier: string): string | undefined {
	if (
		specifier !== WORKSPACE_PREFIX &&
		!specifier.startsWith(`${WORKSPACE_PREFIX}-`) &&
		!specifier.startsWith(`${WORKSPACE_PREFIX}/`)
	) {
		return undefined;
	}
	const parts = specifier.split("/");
	return `${parts[0]}/${parts[1] ?? ""}`.replace(/\/$/, "");
}

/** Package-level edges from the `package.json` dependency fields; self and unknown packages ignored. */
export function declaredGraph(packages: readonly WorkspacePackage[]): PackageGraph {
	const known = new Set(packages.map((p) => p.name));
	const graph: PackageGraph = new Map();
	for (const pkg of packages) {
		graph.set(pkg.name, new Set(pkg.declared.filter((d) => d !== pkg.name && known.has(d))));
	}
	return graph;
}

/** Package-level edges from what the sources actually import (tests included: a test-only edge is still an edge). */
export function importedGraph(
	packages: readonly WorkspacePackage[],
	specifiersOf: (source: string) => string[]
): PackageGraph {
	const known = new Set(packages.map((p) => p.name));
	const graph: PackageGraph = new Map();
	for (const pkg of packages) {
		const edges = new Set<string>();
		for (const source of pkg.sources.values()) {
			for (const spec of specifiersOf(source)) {
				const target = workspacePackageOf(spec);
				if (target !== undefined && target !== pkg.name && known.has(target)) edges.add(target);
			}
		}
		graph.set(pkg.name, edges);
	}
	return graph;
}

/** `pkg -> dep` for every import edge whose dependency the package.json does not declare. */
export function undeclaredImports(imported: PackageGraph, declared: PackageGraph): string[] {
	const missing: string[] = [];
	for (const [from, tos] of imported) {
		for (const to of tos) if (!declared.get(from)?.has(to)) missing.push(`${from} -> ${to}`);
	}
	return missing.sort();
}

export function packageCycles(graph: PackageGraph): string[][] {
	return findCycles(graph);
}
