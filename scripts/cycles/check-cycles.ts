import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { buildClusterGraph, findCycles, mutualPairs } from "./cycles";
import { declaredGraph, importedGraph, packageCycles, undeclaredImports, type WorkspacePackage } from "./packages";

/**
 * Fails (exit 1) on:
 * - a cycle in the package-level graph, declared (`package.json`) or actual (imports, tests included)
 * - an import of a workspace package its `package.json` does not declare
 * - a cycle between top-level `src/` directories inside one package (root files excluded)
 */
const repo = join(import.meta.dir, "..", "..");
const WORKSPACE_DIRS = ["apps/*", "packages/*"];
const SOURCE_GLOB = "**/*.{ts,tsx,mts}";

type PackageJson = {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

async function readSources(root: string, base: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for await (const rel of new Glob(SOURCE_GLOB).scan({ cwd: join(root, base) })) {
		if (rel.includes("node_modules/") || rel.startsWith("dist/") || rel.includes("/dist/") || rel.includes(".expo/"))
			continue;
		files.set(rel, readFileSync(join(root, base, rel), "utf8"));
	}
	return files;
}

/** Files under `src/`, keyed relative to it: the clusters of a package are the top-level directories there. */
function srcOnly(sources: ReadonlyMap<string, string>): Map<string, string> {
	return new Map([...sources].filter(([rel]) => rel.startsWith("src/")).map(([rel, text]) => [rel.slice(4), text]));
}

async function loadPackages(): Promise<{ packages: WorkspacePackage[]; dirs: Map<string, string> }> {
	const packages: WorkspacePackage[] = [];
	const dirs = new Map<string, string>();
	for (const pattern of WORKSPACE_DIRS) {
		for await (const manifest of new Glob(`${pattern}/package.json`).scan({ cwd: repo })) {
			const dir = dirname(manifest);
			const json = JSON.parse(readFileSync(join(repo, manifest), "utf8")) as PackageJson;
			if (!json.name?.startsWith("@delacour/warden")) continue;
			const declared = [
				...Object.keys(json.dependencies ?? {}),
				...Object.keys(json.devDependencies ?? {}),
				...Object.keys(json.peerDependencies ?? {}),
			];
			packages.push({ name: json.name, declared, sources: await readSources(repo, dir) });
			dirs.set(json.name, dir);
		}
	}
	return { packages, dirs };
}

/** Module specifiers a file really imports (lexer based: strings and comments that look like imports are ignored). */
function realImports(source: string): string[] {
	return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/**
 * Packages whose own `src/` clusters are known to be cyclic today; reported, not failing. They are split or
 * re-layered by later WSDK phases (WSDK-6 for apps/cli; packages/e2e was re-layered by WSDK-4/5). Remove entries as they land.
 */
const CLUSTER_CYCLES_PENDING = new Set(["apps/cli", "packages/e2e-bench", "packages/perf"]);

const { packages, dirs } = await loadPackages();
let failed = false;

const declared = declaredGraph(packages);
const imported = importedGraph(packages, realImports);
console.log(`check-cycles: ${packages.length} packages`);
for (const [label, graph] of [
	["declared", declared],
	["imported", imported],
] as const) {
	const cycles = packageCycles(graph);
	for (const c of cycles) console.log(`  ${label} package cycle (SCC): ${c.join(", ")}`);
	if (cycles.length > 0) failed = true;
}
for (const line of undeclaredImports(imported, declared)) {
	console.log(`  undeclared workspace dependency: ${line}`);
	failed = true;
}

for (const pkg of packages) {
	const graph = buildClusterGraph(srcOnly(pkg.sources));
	const cycles = findCycles(graph);
	for (const c of cycles) console.log(`  ${dirs.get(pkg.name)} cluster cycle (SCC): ${c.join(", ")}`);
	for (const p of mutualPairs(graph)) console.log(`  ${dirs.get(pkg.name)} mutual: ${p}`);
	if (cycles.length > 0 && !CLUSTER_CYCLES_PENDING.has(dirs.get(pkg.name) ?? "")) failed = true;
}

process.exit(failed ? 1 : 0);
