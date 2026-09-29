import { appDescription, appName, docsRoute } from "./shared";

export type HeadMeta = { title: string } | { name: string; content: string } | { property: string; content: string };

/** Every tag a docs page owns; TanStack Router keeps the deepest route's copy of each. */
export function docsHead({
	slugs,
	title,
	description,
}: {
	slugs: readonly string[];
	title: string;
	description?: string;
}): {
	meta: HeadMeta[];
} {
	const pageTitle = slugs.length === 0 ? `${appName} docs` : `${title} — ${appName}`;
	const body = description || appDescription;

	return {
		meta: [
			{ title: pageTitle },
			{ name: "description", content: body },
			{ property: "og:title", content: pageTitle },
			{ property: "og:description", content: body },
			{ property: "og:url", content: `${docsRoute}/${slugs.join("/")}` },
		],
	};
}
