import type { LoaderPlugin } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";

/**
 * Page frontmatter: fumadocs' own, plus `sidebarTitle`, a short label for the sidebar when the `title` (the H1 and
 * the search result title) is long, e.g. `title: Write React Native E2E tests`, `sidebarTitle: Write specs`.
 */
export const docsSchema = pageSchema.extend({ sidebarTitle: pageSchema.shape.title.optional() });

/** The sidebar label a page's frontmatter asks for, or `undefined` to keep its title. */
export function sidebarName(data: { title?: string; sidebarTitle?: string }): string | undefined {
	return data.sidebarTitle;
}

/** Names each sidebar item by its page's `sidebarTitle` when it has one. */
export function sidebarTitlePlugin(): LoaderPlugin {
	return {
		name: "warden:sidebar-title",
		transformPageTree: {
			file(node, filePath) {
				if (!filePath) return node;
				const file = this.storage.read(filePath);
				if (file?.format !== "page") return node;
				const name = sidebarName(file.data as { sidebarTitle?: string });
				if (name !== undefined) node.name = name;
				return node;
			},
		},
	};
}
