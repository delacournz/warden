/** Docs pages that moved in the 2026-10 restructure: old slug path → new slug path. */
const MOVED: Record<string, string> = {
	"guides/agents": "agents/rules",
	"guides/agent-ui": "agents/ui",
	"guides/run-e2e": "e2e/suites",
	"guides/specs": "e2e/specs",
	"guides/affected-e2e": "e2e/affected",
	"guides/e2e": "devices/scripts",
	"guides/headless": "devices/headless",
	"guides/ports": "devices/ports",
	"guides/capacity": "devices/capacity",
	"guides/golden-images": "devices/golden-images",
	"guides/app-builds": "devices/app-builds",
	"guides/bench": "bench/run",
};

/**
 * The slashless path (and query) for a URL with a trailing slash, or
 * `undefined` when there is none to strip. The server answers it with a
 * permanent redirect, so a search engine folds `/docs/e2e/` into `/docs/e2e`.
 * Relative, because behind Railway's proxy the request URL's origin is not the
 * public one.
 */
export function trailingSlashTarget(url: URL): string | undefined {
	if (url.pathname === "/" || !url.pathname.endsWith("/")) return undefined;
	return (url.pathname.replace(/\/+$/, "") || "/") + url.search;
}

/** The new slugs for a page that moved, or `undefined` when it never did. */
export function redirectSlugs(slugs: readonly string[]): string[] | undefined {
	const to = MOVED[slugs.join("/")];
	return to === undefined ? undefined : to.split("/");
}
