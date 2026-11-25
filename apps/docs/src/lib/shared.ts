export const appName = "warden";

/** One sentence, served as the social card body and the long-form identity in JSON-LD. */
export const appDescription =
	"warden is an AI agent toolkit to drive, debug, profile and end-to-end test React Native and Expo apps on iOS simulators and Android emulators. Every agent gets its own simulator: warden leases devices, ports and app builds across every worktree on your Mac, so parallel AI coding agents never collide.";

/**
 * The search-result snippet: 120-160 characters so Google shows it whole. Named for the queries
 * warden answers (AI agent toolkit, React Native and Expo E2E testing, iOS simulator, Android emulator, AI coding agents).
 */
export const metaDescription =
	"AI agent toolkit for React Native and Expo E2E testing: every AI coding agent gets its own iOS simulator or Android emulator to drive, debug and profile apps.";

export const docsRoute = "/docs";

/** What warden cloud costs. */
export const pricingRoute = "/pricing";

/** warden cloud's terms of service. */
export const termsRoute = "/terms";

/** The privacy policy; the cookie banner and the footer link to it. */
export const privacyRoute = "/privacy";

/** The production origin. Social cards need absolute URLs; previews share production's artwork. */
export const siteUrl = "https://warden.co.nz";

/** Staging, built from `develop`; it reports to its own PostHog project. */
export const stagingHost = "staging.warden.co.nz";

/** The landing page's card, and the fallback for any route without its own. */
export const defaultOgImage = "/og/default.png";

/** Where `scripts/generate-og.ts` writes a docs page's card; the docs root is `index`. */
export function ogImagePath(slugs: readonly string[]) {
	return `/og${docsRoute}/${slugs.length === 0 ? "index" : slugs.join("/")}.png`;
}

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
