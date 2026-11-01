import { existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Platform } from "@delacour/warden-store/types";
import { importGraphs, LAYOUT_EXT } from "./graph";

export type RouteEntries = {
	/** route files relative to the config dir (posix separators), in the order the routes were given, each once */
	entries: string[];
	/** routes no file under the router root answers to */
	unresolved: string[];
};

export class RouteResolver {
	/**
	 * The file an Expo Router route key (`(tabs)/todos`, `todo/[id]`, `index`) lives in below `routerRoot`: `<key>` or
	 * `<key>/index`, per-platform variants (`.ios`, `.native`) first, as the router and `routerLayouts` look for them.
	 */
	file(route: string, routerRoot: string, platform: Platform): string | undefined {
		const key = this.normalize(route);
		for (const suffix of importGraphs.platformSuffixes(platform)) {
			for (const ext of LAYOUT_EXT) {
				const hit = [join(routerRoot, `${key}${suffix}${ext}`), join(routerRoot, key, `index${suffix}${ext}`)].find(
					(path) => this.isFile(path)
				);
				if (hit) return hit;
			}
		}
		return undefined;
	}

	/** Map visited routes to `specs.<id>.entries`: files below `routerRoot` (absolute), written relative to `configDir`. `_layout`s above them need no entry (`routerLayouts` adds them). */
	entries(routes: readonly string[], routerRoot: string, configDir: string, platform: Platform): RouteEntries {
		const entries: string[] = [];
		const unresolved: string[] = [];
		for (const route of routes) {
			const file = this.file(route, routerRoot, platform);
			if (file === undefined) {
				if (!unresolved.includes(route)) unresolved.push(route);
				continue;
			}
			const entry = relative(configDir, file).split(sep).join("/");
			if (!entries.includes(entry)) entries.push(entry);
		}
		return { entries, unresolved };
	}

	private isFile(path: string): boolean {
		return existsSync(path) && statSync(path).isFile();
	}

	/** `/(tabs)/todos/` → `(tabs)/todos`; `/` and the empty route are `index`. */
	private normalize(route: string): string {
		const key = route.replace(/^\/+|\/+$/g, "");
		return key === "" ? "index" : key;
	}
}

export const routeResolver = new RouteResolver();
