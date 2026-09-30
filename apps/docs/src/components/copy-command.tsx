import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";

/** A shell command on one line with a copy button; the command is the label, so it is never truncated away. */
export function CopyCommand({ command }: { command: string }): ReactElement {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};

	return (
		<div className="flex min-w-0 items-center gap-2 rounded-xl bg-ground py-1.5 ps-4 pe-1.5">
			<code className="min-w-0 flex-1 whitespace-pre-wrap font-mono [overflow-wrap:anywhere] text-ink text-sm sm:overflow-x-auto sm:whitespace-nowrap">
				<span className="select-none text-ink-2">$ </span>
				{command}
			</code>
			<button
				aria-label={copied ? "Copied" : `Copy ${command}`}
				className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-fill hover:text-ink"
				onClick={copy}
				type="button"
			>
				{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
			</button>
		</div>
	);
}
