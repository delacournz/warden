import { docsRoute, encodeMarkdownUrl } from "./shared";

/**
 * Docs pages that moved: old slug path → current slug path. Two restructures feed it: the 2026-10
 * one (`guides/*`), the 2026-11 device-conditions split and the 2026-11 split into top tabs (Getting Started, Agents & Simulators, E2E
 * Tests, Reference, Releases). Every target is a live page, never another old path.
 */
const MOVED: Record<string, string> = {
	"guides/agents": "sims/rules",
	"guides/agent-ui": "sims/ui",
	"guides/run-e2e": "e2e/suites",
	"guides/specs": "e2e/specs",
	"guides/affected-e2e": "e2e/affected",
	"guides/e2e": "sims/scripts",
	"guides/headless": "sims/headless",
	"guides/ports": "sims/ports",
	"guides/capacity": "sims/capacity",
	"guides/golden-images": "sims/golden-images",
	"guides/app-builds": "sims/app-builds",
	"guides/bench": "e2e/bench/run",

	"": "getting-started",
	index: "getting-started",
	quickstart: "getting-started/quickstart",
	installation: "getting-started/installation",
	"agent-setup": "getting-started/agent-setup",
	concepts: "getting-started/concepts",

	agents: "sims/agent-loop",
	"agents/ui": "sims/ui",
	"agents/dev": "sims/dev",
	"agents/debug": "sims/debug",
	"agents/rules": "sims/rules",
	devices: "sims",
	"devices/leases": "sims/leases",
	"devices/physical-devices": "sims/physical-devices",
	"devices/scripts": "sims/scripts",
	"devices/ports": "sims/ports",
	"devices/capacity": "sims/capacity",
	"devices/golden-images": "sims/golden-images",
	"devices/perf": "sims/perf",
	"devices/headless": "sims/headless",
	"devices/app-builds": "sims/app-builds",

	"e2e/first-test": "e2e",
	"e2e/biometrics": "e2e/conditions/biometrics",
	"e2e/camera": "e2e/conditions/camera",
	bench: "e2e/bench/comparison",
	"bench/comparison": "e2e/bench/comparison",
	"bench/run": "e2e/bench/run",
	"bench/ios-2026-10-25": "e2e/bench/ios-2026-10-25",

	"release-notes": "releases",
	updating: "releases/updating",
	contributing: "releases/contributing",
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
	if (to === undefined) return undefined;
	return to.split("/").filter(Boolean);
}

/**
 * Rewrites every `/docs/<old>` link in a text to its current path, keeping an `#anchor` or `.md`
 * suffix. The bare `/docs` root is left alone: the server redirects it.
 */
export function rewriteDocsLinks(text: string): string {
	return text.replace(/\/docs\/([a-z0-9][a-z0-9/-]*[a-z0-9]|[a-z0-9])(?![a-z0-9/-])/g, (whole, path: string) => {
		const to = MOVED[path];
		return to === undefined ? whole : `/docs/${to}`;
	});
}

/**
 * The `.md` twin of a docs URL (query kept), for a client that prefers `text/markdown`. Relative like
 * {@link trailingSlashTarget}: behind Railway's proxy the request URL is `http://`, and an absolute one sent agents
 * through an extra http → https hop.
 */
export function markdownTwinTarget(url: URL): string {
	const slugs = url.pathname
		.slice(docsRoute.length)
		.split("/")
		.filter((v) => v.length > 0);
	return encodeMarkdownUrl(slugs) + url.search;
}
