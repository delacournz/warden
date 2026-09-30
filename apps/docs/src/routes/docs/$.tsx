import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { DocsToolbar } from "@/components/docs-toolbar";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { docsHead } from "@/lib/seo";
import { encodeMarkdownUrl } from "@/lib/shared";
import { docs, source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
	component: Page,
	loader: async ({ params }) => {
		const slugs = params._splat?.split("/").filter(Boolean) ?? [];
		const data = await serverLoader({ data: slugs });
		await docs.getPage(data.path)?.preload();
		return data;
	},
	head: ({ loaderData }) => (loaderData ? docsHead(loaderData) : {}),
});

const serverLoader = createServerFn({
	method: "GET",
})
	.validator((slugs: string[]) => slugs)
	.handler(async ({ data: slugs }) => {
		const page = source.getPage(slugs);
		if (!page) throw notFound();

		return {
			path: page.path,
			slugs: page.slugs,
			title: page.data.title,
			description: page.data.description,
			markdownUrl: encodeMarkdownUrl(page.slugs, page.locale),
			pageTree: await source.serializePageTree(source.getPageTree()),
		};
	});

function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) {
	const page = docs.getPage(path);
	if (!page) throw new Error(`unknown page: ${path}`);

	const { toc } = use(page.load());
	const MDX = page.body;

	return (
		<DocsPage toc={toc}>
			<DocsTitle>{page.title}</DocsTitle>
			<DocsDescription>{page.description}</DocsDescription>
			<DocsToolbar markdownUrl={markdownUrl} path={path} />
			<DocsBody>
				<MDX components={useMDXComponents()} />
			</DocsBody>
		</DocsPage>
	);
}

function Page() {
	const { path, pageTree, markdownUrl } = useFumadocsLoader(Route.useLoaderData());

	return (
		<DocsLayout {...baseOptions()} links={[]} tree={pageTree}>
			<Suspense>
				<Content markdownUrl={markdownUrl} path={path} />
			</Suspense>
		</DocsLayout>
	);
}
