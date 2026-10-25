import { existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Platform } from "../types";
import { LAYOUT_EXT, platformSuffixes } from "./graph";

export type RouteEntries = {
	/** route files relative to the config dir (posix separators), in the order the routes were given, each once */
	entries: string[];
	/** routes no file under the router root answers to */
	unresolved: string[];
};

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** `/(tabs)/todos/` → `(tabs)/todos`; `/` and the empty route are `index`. */
function normalize(route: string): string {
	const key = route.replace(/^\/+|\/+$/g, "");
	return key === "" ? "index" : key;
}

/**
 * The file an Expo Router route key (`(tabs)/todos`, `todo/[id]`, `index`) lives in below `routerRoot`: `<key>` or
 * `<key>/index`, per-platform variants (`.ios`, `.native`) first, as the router and `routerLayouts` look for them.
 */
export function routeFile(route: string, routerRoot: string, platform: Platform): string | undefined {
	const key = normalize(route);
	for (const suffix of platformSuffixes(platform)) {
		for (const ext of LAYOUT_EXT) {
			const hit = [join(routerRoot, `${key}${suffix}${ext}`), join(routerRoot, key, `index${suffix}${ext}`)].find(
				isFile
			);
			if (hit) return hit;
		}
	}
	return undefined;
}

/** Map visited routes to `specs.<id>.entries`: files below `routerRoot` (absolute), written relative to `configDir`. `_layout`s above them need no entry (`routerLayouts` adds them). */
export function routeEntries(
	routes: readonly string[],
	routerRoot: string,
	configDir: string,
	platform: Platform
): RouteEntries {
	const entries: string[] = [];
	const unresolved: string[] = [];
	for (const route of routes) {
		const file = routeFile(route, routerRoot, platform);
		if (file === undefined) {
			if (!unresolved.includes(route)) unresolved.push(route);
			continue;
		}
		const entry = relative(configDir, file).split(sep).join("/");
		if (!entries.includes(entry)) entries.push(entry);
	}
	return { entries, unresolved };
}
