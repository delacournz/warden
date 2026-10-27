import type { ReactTree, TreeComponent } from "@delacour/warden-e2e/devtools/devtools.types";

export type TreeFilter = { depth?: number; testID?: string };

/** 0 for a root of the selection, parent + 1 inside one, `undefined` outside every selected subtree. */
function depthOf(component: TreeComponent, filter: TreeFilter, kept: ReadonlyMap<number, number>): number | undefined {
	const isRoot = filter.testID === undefined ? component.parent === null : component.testID === filter.testID;
	if (isRoot) return 0;
	const parentDepth = component.parent === null ? undefined : kept.get(component.parent);
	return parentDepth === undefined ? undefined : parentDepth + 1;
}

/**
 * The part of a React tree a caller asked for: the subtree of every component with `testID` (or the whole tree),
 * cut `depth` levels below those roots (0 = the roots only). Component ids and parents are kept, so
 * `formatTree` shows the cut subtree with the root at the left edge.
 */
export function filterTree(tree: ReactTree, filter: TreeFilter): ReactTree {
	if (filter.depth === undefined && filter.testID === undefined) return tree;
	const kept = new Map<number, number>();
	const components: TreeComponent[] = [];
	for (const component of tree.components) {
		const depth = depthOf(component, filter, kept);
		if (depth === undefined || (filter.depth !== undefined && depth > filter.depth)) continue;
		kept.set(component.id, depth);
		components.push(component);
	}
	return { ...tree, components };
}
