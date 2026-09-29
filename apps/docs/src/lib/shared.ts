export const appName = "warden";

/** One sentence, served as the meta description and the social card body. */
export const appDescription =
	"Machine-wide leasing of iOS simulators, Android emulators, ports and native app builds for agents, worktrees and humans sharing one Mac.";

export const docsRoute = "/docs";

export const gitConfig = {
	user: "delacournz",
	repo: "warden",
	branch: "main",
};

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

export function encodeMarkdownUrl(slugs: string[], locale?: string) {
	const segments = [...slugs];
	if (segments.length === 0) {
		segments.push("index.md");
	} else {
		segments[segments.length - 1] += ".md";
	}

	return `/${[locale, ...docsRoute.split("/"), ...segments].filter(Boolean).join("/")}`;
}

/** @returns page slugs */
export function decodeMarkdownUrl(segments: string[]) {
	if (segments.length === 0) return [];

	const out = [...segments];
	out[out.length - 1] = out[out.length - 1].replace(/\.md$/, "");
	if (out.length === 1 && out[0] === "index") out.pop();
	return out;
}

/**
 * Does this href point at a file the server hands back whole (`/llms.txt`, a
 * page's `.md` twin) rather than a page the router renders? The client router
 * would match such a path and render the 404, so it must stay a plain anchor.
 */
export function isFileHref(href: string) {
	if (!href.startsWith("/") || href.startsWith("//")) return false;
	const path = href.split(/[?#]/)[0];
	return path.slice(path.lastIndexOf("/") + 1).includes(".");
}
