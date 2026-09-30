import type { ReactElement, ReactNode } from "react";

/**
 * The hub's one container: a grouped inset list. Rows are separated by an
 * inset hairline that starts after the leading glyph, the way system lists do.
 */
export function GroupedList({ children, label }: { children: ReactNode; label?: string }): ReactElement {
	return (
		<ul aria-label={label} className="overflow-hidden rounded-[var(--radius-group)] bg-surface">
			{children}
		</ul>
	);
}

export function GroupedRow({
	leading,
	title,
	detail,
	trailing,
}: {
	leading?: ReactNode;
	title: ReactNode;
	detail?: ReactNode;
	trailing?: ReactNode;
}): ReactElement {
	return (
		<li className="group flex items-start gap-3 ps-4">
			{leading ? (
				<span className="mt-3.5 flex size-5 shrink-0 items-center justify-center text-ink">{leading}</span>
			) : null}
			<div className="flex min-w-0 flex-1 items-start gap-4 border-hairline border-b py-3 pe-4 group-last:border-b-0">
				<div className="min-w-0 flex-1">
					<p className="font-medium text-ink">{title}</p>
					{detail ? <p className="mt-0.5 text-ink-2 text-sm">{detail}</p> : null}
				</div>
				{trailing ? <div className="shrink-0 pt-0.5">{trailing}</div> : null}
			</div>
		</li>
	);
}
