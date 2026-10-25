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

/** The new slugs for a page that moved, or `undefined` when it never did. */
export function redirectSlugs(slugs: readonly string[]): string[] | undefined {
	const to = MOVED[slugs.join("/")];
	return to === undefined ? undefined : to.split("/");
}
