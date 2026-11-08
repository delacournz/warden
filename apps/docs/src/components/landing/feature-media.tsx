import { type ReactElement, type ReactNode, useRef, useState } from "react";
import { CLIP_CHIP, ExpandClip } from "@/components/landing/expand-clip";
import { QuietVideo } from "@/components/quiet-video";

/**
 * A landing feature's media: its recorded clip (muted, looping, at rest on the poster under reduced motion) at the
 * full content width, with two real buttons below it: "show code" swaps in the text sample (`aria-pressed`), and
 * "expand" is {@link ExpandClip}: a large modal on desktop, native fullscreen on touch. With no clip the sample shows
 * alone.
 */
export function FeatureMedia({
	clip,
	sample,
}: {
	clip?: { src: string; label: string };
	sample: ReactNode;
}): ReactElement {
	const [showCode, setShowCode] = useState(false);
	const media = useRef<HTMLDivElement>(null);
	if (!clip) return <>{sample}</>;

	return (
		<div className="flex flex-col gap-3">
			<div ref={media}>
				{showCode ? (
					sample
				) : (
					<QuietVideo
						className="w-full rounded-[var(--radius-group)] border border-hairline"
						label={clip.label}
						src={clip.src}
					/>
				)}
			</div>
			<div className="flex gap-2">
				<button aria-pressed={showCode} className={CLIP_CHIP} onClick={() => setShowCode((on) => !on)} type="button">
					{showCode ? "show clip" : "show code"}
				</button>
				<ExpandClip container={media} label={clip.label} src={clip.src} />
			</div>
		</div>
	);
}
