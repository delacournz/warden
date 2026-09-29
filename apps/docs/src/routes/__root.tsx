import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { appDescription, appName } from "@/lib/shared";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: `${appName} — device leasing for agents` },
			{ name: "description", content: appDescription },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: appName },
			{ property: "og:title", content: `${appName} — device leasing for agents` },
			{ property: "og:description", content: appDescription },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
		],
	}),
	component: RootComponent,
});

function RootComponent() {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="flex min-h-screen flex-col">
				<RootProvider>
					<Outlet />
				</RootProvider>
				<Scripts />
			</body>
		</html>
	);
}
