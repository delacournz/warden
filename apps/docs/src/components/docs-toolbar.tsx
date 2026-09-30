import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";
import type { ReactElement } from "react";
import { gitConfig } from "@/lib/shared";

/**
 * The row under a docs page's description: copy as Markdown, open elsewhere,
 * and the page's own id — its Markdown path, the address an agent fetches —
 * set in mono on the right, the way every device on the shelf carries its udid.
 */
export function DocsToolbar({ path, markdownUrl }: { path: string; markdownUrl: string }): ReactElement {
	return (
		<div className="-mt-4 flex flex-row items-center gap-2 border-fd-border border-b pb-6">
			<MarkdownCopyButton markdownUrl={markdownUrl} />
			<ViewOptionsPopover
				githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${path}`}
				markdownUrl={markdownUrl}
			/>
			<a
				className="ms-auto hidden truncate font-mono text-ink-2 text-xs underline-offset-4 hover:text-ink hover:underline sm:block"
				href={markdownUrl}
			>
				{markdownUrl}
			</a>
		</div>
	);
}
