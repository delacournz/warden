import type { ReactElement } from "react";

/**
 * One word that drops signal now and then, like a simulator screen hiccuping mid-frame. The real text stays a single
 * selectable node; two `aria-hidden` copies carry the torn slices (the word's own colour on a ground-backed band, and
 * a paler accent channel offset the other way), clipped with `inset()` and stepped through a burst of about half a second
 * every five. `offset` runs the word on its own longer period, so two words drift in and out of phase. Reduced motion shows the clean word
 * and no layers. The styles are the `glitch` block in `app.css`.
 */
export function GlitchWord({
	children,
	className = "",
	offset = false,
}: {
	children: string;
	className?: string;
	offset?: boolean;
}): ReactElement {
	return (
		<span className={`glitch ${offset ? "glitch-offset " : ""}${className}`}>
			{children}
			<span aria-hidden="true" className="glitch-layer glitch-tear">
				{children}
			</span>
			<span aria-hidden="true" className="glitch-layer glitch-chroma">
				{children}
			</span>
		</span>
	);
}
