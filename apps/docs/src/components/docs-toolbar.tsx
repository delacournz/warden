import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";
import type { ReactElement } from "react";
import { gitConfig } from "@/lib/shared";

/** The row under a docs page's description: copy as Markdown, or open the page elsewhere (GitHub, an LLM). */
export function DocsToolbar({ path, markdownUrl }: { path: string; markdownUrl: string }): ReactElement {
	return (
		<div className="-mt-4 flex flex-row items-center gap-2 border-fd-border border-b pb-6">
			<MarkdownCopyButton markdownUrl={markdownUrl} />
			<ViewOptionsPopover
				githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${path}`}
				markdownUrl={markdownUrl}
			/>
		</div>
	);
}
