import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { defineDocs } from "fumadocs-mdx/macro";
import { DEVICE_CONTROL } from "./landing.data";
import { demosAsMarkdown } from "./llms";
import { docsRoute } from "./shared";
import { docsSchema, sidebarTitlePlugin } from "./sidebar-title";

export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		schema: docsSchema,
		async: true,
		postprocess: {
			includeProcessedMarkdown: true,
		},
	},
});

export const source = loader({
	source: docs.toFumadocsSource(),
	baseUrl: docsRoute,
	plugins: [lucideIconsPlugin(), sidebarTitlePlugin()],
});

export async function getLLMText(page: (typeof source)["$inferPage"]) {
	const processed = demosAsMarkdown(await page.data.getText("processed"), DEVICE_CONTROL.clips);

	return `# ${page.data.title} (${page.url})

${processed}`;
}
