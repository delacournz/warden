import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { appDescription, appName } from "@/lib/shared";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: `${appName} — one simulator per agent` },
			{ name: "description", content: appDescription },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: appName },
			{ property: "og:title", content: `${appName} — one simulator per agent` },
			{ property: "og:description", content: appDescription },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
		],
	}),
	component: RootComponent,
});

/**
 * The direction contract this site was built to, first child of `<body>`, so
 * it survives into the shipped HTML. React cannot emit a bare comment, so it
 * rides inside an inert `<template>`.
 */
const DIRECTION_CONTRACT = `<!--
impeccable direction contract · seed 2cb47fe7
THESIS: warden's site is its own device shelf. Every sim is a leased unit with owner, udid and boot time; it refuses the dark terminal hero over a six-card feature grid.
OWN-WORLD: system-UI grammar on grouped gray (#f2f2f7 / #000), white or #1c1c1e inset groups, hairline separators, drawn phone outlines, Onest over Red Hat Mono ids. One saturated colour, lease green, means "leased"; nothing else is coloured.
STORY: an agent-heavy developer sees one sim per agent and a 16 s boot, watches a claim reuse then clone, reads the measured axis, learns the lease rules, installs.
FIRST VIEWPORT: two-line headline left (isolation / speed), lede and two pill CTAs right; below, the full-width shelf of four devices with live boot timer and claim / release controls.
FORM: Device Hub, position 4 of 7, seed 2cb47fe7.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->`;

function DirectionContract() {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: a static, inert comment constant — no user input reaches it.
	return <template dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} id="direction-contract" />;
}

function RootComponent() {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="flex min-h-screen flex-col bg-ground">
				<DirectionContract />
				<RootProvider>
					<Outlet />
				</RootProvider>
				<Scripts />
			</body>
		</html>
	);
}
