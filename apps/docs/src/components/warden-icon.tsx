import type { ReactElement } from "react";

/**
 * The warden mark: a device outline with its lease lamp lit. Two shapes and
 * one colour, so it survives favicon size; the outline takes `currentColor`.
 */
export function WardenIcon({ size = 20, className }: { size?: number; className?: string }): ReactElement {
	return (
		<svg aria-hidden="true" className={className} fill="none" height={size} viewBox="0 0 24 24" width={size}>
			<rect height="20" rx="4.5" stroke="currentColor" strokeWidth="2" width="13" x="3" y="2" />
			<circle className="fill-lamp" cx="18" cy="6" r="4" />
		</svg>
	);
}
