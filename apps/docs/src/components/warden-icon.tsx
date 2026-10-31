import type { ReactElement } from "react";

/**
 * The warden mark: a pair of square brackets (a leased scope, set like the code
 * the name is) around a square lamp lit in the accent. Butt caps and mitred
 * corners keep it squared like the Chakra Petch accents; two shapes and one
 * colour survive favicon size, and the brackets take `currentColor`.
 */
export function WardenIcon({ size = 20, className }: { size?: number; className?: string }): ReactElement {
	return (
		<svg aria-hidden="true" className={className} fill="none" height={size} viewBox="0 0 24 24" width={size}>
			<path d="M9 3H4V21H9M15 3H20V21H15" stroke="currentColor" strokeWidth="2.5" />
			<rect className="fill-lamp" height="6" width="6" x="9" y="9" />
		</svg>
	);
}
