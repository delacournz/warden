import type { ReactElement, ReactNode } from "react";

/**
 * The two marks the privacy copy writes inline, `` `code` `` and `[text](url)`,
 * rendered as `<code>` and an `<a>`.
 *
 * Not a Markdown parser. Two marks are what the copy uses, and a real parser
 * here would be a second one beside Fumadocs' for a page of sentences.
 */
const MARK = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

export function RichText({ text }: { text: string }): ReactElement {
	const nodes: ReactNode[] = text.split(MARK).map((part, index) => {
		if (part.startsWith("`") && part.endsWith("`")) {
			return (
				<code
					className="whitespace-nowrap rounded-[4px] bg-fill px-1 py-0.5 font-mono text-[0.85em] text-ink"
					key={`${index}-${part}`}
				>
					{part.slice(1, -1)}
				</code>
			);
		}

		const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
		if (link) {
			// Only a web page gets a new tab. A `mailto:` given `_blank` opens an
			// empty tab beside the mail client in some browsers.
			const external = /^https?:\/\//.test(link[2] as string);

			return (
				<a
					className="text-ink underline decoration-ink-2 underline-offset-4 transition-colors hover:decoration-accent"
					href={link[2]}
					key={`${index}-${part}`}
					rel={external ? "noreferrer noopener" : undefined}
					target={external ? "_blank" : undefined}
				>
					{link[1]}
				</a>
			);
		}

		return part;
	});

	return <>{nodes}</>;
}

/** The plain text a `RichText` string renders to, for a test or an `aria-label`. */
export function plainText(text: string): string {
	return text.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}
