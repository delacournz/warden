import { basename, resolve } from "node:path";
import type { Suite } from "@delacour/warden-core/affected/affected";
import type { Platform } from "@delacour/warden-core/types";
import type { RecordedStep } from "@delacour/warden-e2e/authoring/recording.schema";
import { slugOf } from "./authoring-target";

/**
 * What `record stop` proposes for `warden.config.ts` once a spec is written: the `specs.<id>` entry mapping the spec to
 * the route files it drives, so `warden affected` selects it when those screens change. Printed, never written.
 */
export type SpecConfig = {
	/** the spec's id below the suite's `specsDir` (the `specs` key) */
	id: string;
	/** the suite the entry belongs in, when one was found */
	suite?: string;
	/** `specs: { … }` source to paste into `e2e.<suite>` */
	snippet: string;
	/** route files relative to the config dir; empty when nothing could be mapped */
	entries: string[];
	/** the routes the recording visited, in order (Expo Router keys such as `(tabs)/todos`) */
	routes: string[];
	/** visited routes with no file under `routerRoot` */
	unresolved: string[];
	/** at least one route was read from the app (a dev client); false = fill `entries` by hand */
	captured: boolean;
	hints: string[];
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The `specs` block for one spec: `entries` one per line, or an empty list with the hint to fill it. */
export function renderSnippet(id: string, entries: readonly string[]): string {
	const key = IDENTIFIER.test(id) ? id : JSON.stringify(id);
	if (entries.length === 0) return `specs: {\n\t${key}: { entries: [] }, // TODO: the screens this spec drives\n},`;
	const lines = entries.map((entry) => `\t\t\t${JSON.stringify(entry)},`);
	return `specs: {\n\t${key}: {\n\t\tentries: [\n${lines.join("\n")}\n\t\t],\n\t},\n},`;
}

/** Visited routes in order, each once: the one at `record start`, the ones the steps recorded, the one at `record stop`. */
export function visitedRoutes(
	initial: string | undefined,
	stepRoutes: readonly (string | undefined)[],
	final: string | undefined
): string[] {
	const all = [initial, ...stepRoutes, final].flatMap((route) => (route === undefined ? [] : [route]));
	return all.filter((route, at) => all.indexOf(route) === at);
}

/**
 * The routes a recording's steps contribute, in step order: a `use` step brings the routes its helper visited
 * (`record use` merged them) before the route it ended on.
 */
export function stepRoutes(steps: readonly RecordedStep[]): (string | undefined)[] {
	return steps.flatMap((step) => (step.kind === "use" ? [...(step.visited ?? []), step.route] : [step.route]));
}

/** The helpers a recording calls whose screens are only partly known: no recording of their own, so just the reads around the run. */
export function helpersWithGaps(steps: readonly RecordedStep[]): string[] {
	const gaps = steps.flatMap((step) =>
		step.kind === "use" && (step.visited === undefined || step.partial === true) ? [step.fn] : []
	);
	return gaps.filter((fn, at) => gaps.indexOf(fn) === at);
}

export type SpecConfigInput = {
	/** the written spec file */
	file: string;
	routes: readonly string[];
	suite: Suite | undefined;
	devicePlatform: Platform;
	/** helpers called with `record use` whose routes are only partly known (see `helpersWithGaps`) */
	helperGaps?: readonly string[];
	/** route files for the visited routes (core's resolver); injected so this stays pure */
	resolveRoutes: (
		routes: readonly string[],
		routerRoot: string,
		configDir: string,
		platform: Platform
	) => {
		entries: string[];
		unresolved: string[];
	};
	/** the id of a spec file below `specsDir` (core's `specIdOf`) */
	specId: (file: string, specsDir: string) => string;
};

export function specConfigFor(input: SpecConfigInput): SpecConfig {
	const { suite, routes, file } = input;
	const hints: string[] = [];
	const id = suite
		? input.specId(file, resolve(suite.configDir, suite.config.specsDir))
		: basename(file)
				.replace(/\.e2e\.tsx?$/, "")
				.replace(/\.tsx?$/, "") || slugOf(basename(file));
	let entries: string[] = [];
	let unresolved: string[] = [];
	const { routerRoot } = suite?.config ?? {};
	if (routes.length === 0) {
		hints.push(
			"no routes were read from the app (a release build, or Metro was not reachable): fill `entries` by hand"
		);
	} else if (!suite || routerRoot === undefined) {
		hints.push(
			suite
				? "set `routerRoot` on the suite so routes map to files"
				: "no suite found: add the entries to the right `e2e.<suite>`"
		);
	} else {
		({ entries, unresolved } = input.resolveRoutes(
			routes,
			resolve(suite.configDir, routerRoot),
			suite.configDir,
			suite.config.platform ?? input.devicePlatform
		));
		if (unresolved.length > 0) hints.push(`no file under ${routerRoot} for: ${unresolved.join(", ")}`);
	}
	if (input.helperGaps !== undefined && input.helperGaps.length > 0) {
		hints.push(
			`helper ${input.helperGaps.join(", ")} (\`record use\`) drives screens this recording never saw and has no recording of its own: add the entries it covers by hand`
		);
	}
	return {
		id,
		...(suite ? { suite: suite.name } : {}),
		snippet: renderSnippet(id, entries),
		entries,
		routes: [...routes],
		unresolved,
		captured: routes.length > 0,
		hints,
	};
}
