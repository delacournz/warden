import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";
import { track } from "@/lib/analytics/track";

/** A multi-line block to paste somewhere else (an agent prompt), on a flat sheet with a copy button in its tab. */
export function CopyBlock({ text, label }: { text: string; label: string }): ReactElement {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			track({ name: "copy", what: "agent-prompt" });
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};

	return (
		<figure className="flex min-w-0 flex-col rounded-[var(--radius-group)] border border-hairline bg-surface">
			<figcaption className="flex items-center justify-between border-hairline border-b ps-4 pe-1.5 py-1.5 font-mono text-[11px] text-ink-2">
				{label}
				<button
					aria-label={copied ? "Copied" : `Copy ${label}`}
					className="flex h-7 items-center gap-1.5 rounded-full px-3 text-ink transition-colors hover:bg-fill"
					onClick={copy}
					type="button"
				>
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
					{copied ? "copied" : "copy"}
				</button>
			</figcaption>
			<p className="whitespace-pre-line p-5 text-ink leading-relaxed">{text}</p>
		</figure>
	);
}
