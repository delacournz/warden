import { type ReactElement, useEffect, useRef, useState } from "react";
import { ExpandClip } from "@/components/landing/expand-clip";

/** Tracks `prefers-reduced-motion`; `true` on the server so nothing autoplays before hydration decides. */
export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(true);
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(query.matches);
		const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return reduced;
}

/**
 * A recorded reel with a caption: `public/<src>.{webm,mp4,jpg}` (pass `src` without the extension), `label` for
 * screen readers, `command` and `facts` in the caption. It autoplays muted and loops; with reduced motion it rests
 * on the poster (the final frame) and offers controls instead.
 */
export function DemoReel({
	src,
	label,
	command,
	facts,
}: {
	src: string;
	label: string;
	command: string;
	facts: string;
}): ReactElement {
	const reduced = useReducedMotion();
	const ref = useRef<HTMLVideoElement>(null);
	const media = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		if (reduced) video.pause();
		else void video.play().catch(() => undefined);
	}, [reduced]);
	return (
		<figure className="flex flex-col gap-3">
			<div className="overflow-hidden rounded-[var(--radius-group)] bg-surface" ref={media}>
				<video
					aria-label={label}
					autoPlay={!reduced}
					className="block h-auto w-full"
					controls={reduced}
					loop
					muted
					playsInline
					poster={`${src}.jpg`}
					preload="metadata"
					ref={ref}
				>
					<source src={`${src}.webm`} type="video/webm" />
					<source src={`${src}.mp4`} type="video/mp4" />
				</video>
			</div>
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-ink-2 text-sm">
				<code className="font-mono text-ink">{command}</code>
				<span className="font-mono tabular-nums">{facts}</span>
				<ExpandClip container={media} label={label} src={src} />
			</figcaption>
		</figure>
	);
}
