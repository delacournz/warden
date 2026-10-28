import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { useEffect } from "react";
import { ConsentBanner } from "@/components/consent-banner";
import { TrackedSearchDialog } from "@/components/search-dialog";
import { startPosthog } from "@/lib/analytics/posthog";
import { installClickTracking } from "@/lib/analytics/track";
import { socialImageMeta, tagline } from "@/lib/seo";
import { appDescription, appName, defaultOgImage } from "@/lib/shared";
import { themeHeadScript } from "@/lib/theme";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: `${appName} — ${tagline}` },
			{ name: "description", content: appDescription },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: appName },
			{ property: "og:title", content: `${appName} — ${tagline}` },
			{ property: "og:description", content: appDescription },
			...socialImageMeta(defaultOgImage, `${appName} — ${tagline}`),
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
		],
		scripts: [themeHeadScript],
	}),
	component: RootComponent,
});

/**
 * The direction contract this site was built to, first child of `<body>`, so
 * it survives into the shipped HTML. React cannot emit a bare comment, so it
 * rides inside an inert `<template>`.
 */
const DIRECTION_CONTRACT = `<!--
impeccable direction contract · seed 2f6f6e25, re-steered: familiar agent dev-tool frame, one wide heavy display voice
THESIS: the familiar agent dev-tool landing (centered hero, install, demo, Works with row, alternating feature blocks), carried by one display voice. Refuses the dark terminal hero, condensed-light cuts and giant-word beats.
OWN-WORLD: flat paper #f5f4ef / #0f0f0e, one ink, one accent #ff4f1a for large marks; Mona Sans at wdth 125 / wght 800 for every heading, Martian Mono at 11-12px for commands and readouts; hairline rules, 6px sheets, no shadows.
STORY: a mobile dev running agents in parallel worktrees reads "Every agent gets its own simulator.", copies the install, watches the recorded 5-sim run, finds their agent in the Works with row, sees five agents on one Mac in the lease board, reads the lease rules, follows run / drive / debug / keep / run the suite, pastes the first prompt, installs.
FIRST VIEWPORT: centered pill, wide heavy headline (simulator. in accent), one-sentence lede, install tabs, Get started + Watch the demo; recorded run below.
FORM: canon, seed 2f6f6e25.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->`;

function DirectionContract() {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: a static, inert comment constant — no user input reaches it.
	return <template dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} id="direction-contract" />;
}

/**
 * Theming is `@/lib/theme`: an inline head script sets `.dark` before first
 * paint. Fumadocs' own provider (next-themes) is switched off; its script
 * lands in `<body>`, late enough to flash the light ground.
 *
 * Search is Fumadocs' own dialog rebuilt so the query can be counted, see
 * `search-dialog.tsx`, and one delegated listener counts outbound links,
 * downloads and code copies on every route. PostHog starts on mount, on the
 * client only; it has no tag in `<head>`, see `src/lib/analytics/posthog.ts`.
 * The consent banner asks once whether it may set a cookie and record.
 */
function RootComponent() {
	useEffect(() => startPosthog(), []);
	useEffect(() => installClickTracking(), []);

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="flex min-h-screen flex-col bg-ground">
				<DirectionContract />
				<RootProvider search={{ SearchDialog: TrackedSearchDialog }} theme={{ enabled: false }}>
					<Outlet />
					<ConsentBanner />
				</RootProvider>
				<Scripts />
			</body>
		</html>
	);
}
