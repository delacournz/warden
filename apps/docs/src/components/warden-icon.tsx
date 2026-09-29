import type { ReactElement } from "react";

/** The warden mark: a shield with a key slot. Uses `currentColor` for the outline and the brand accent for the slot. */
export function WardenIcon({ size = 20, className }: { size?: number; className?: string }): ReactElement {
	return (
		<svg aria-hidden="true" className={className} fill="none" height={size} viewBox="0 0 24 24" width={size}>
			<path
				d="M12 2.5 4 5.5v6c0 4.9 3.3 8.7 8 10 4.7-1.3 8-5.1 8-10v-6l-8-3Z"
				stroke="currentColor"
				strokeLinejoin="round"
				strokeWidth={1.75}
			/>
			<circle cx="12" cy="10.5" fill="var(--color-fd-primary)" r="2" />
			<path d="M12 12.5v3.5" stroke="var(--color-fd-primary)" strokeLinecap="round" strokeWidth={2} />
		</svg>
	);
}
