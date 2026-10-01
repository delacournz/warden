import { type ReactElement, useEffect, useRef, useState } from "react";

const SRC = "/demo";

/** Tracks `prefers-reduced-motion`; `true` on the server so nothing autoplays before hydration decides. */
function useReducedMotion(): boolean {
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
 * The hero demo: a recorded `warden batch` run fanning salient's end-to-end flows
 * across five leased iOS simulators, sped up to under a minute. It autoplays
 * muted and loops; with reduced motion it rests on the poster (the final
 * all-green frame) and offers controls instead.
 */
export function DemoVideo(): ReactElement {
	const reduced = useReducedMotion();
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		if (reduced) video.pause();
		else void video.play().catch(() => undefined);
	}, [reduced]);
	return (
		<figure className="flex flex-col gap-3">
			<div className="overflow-hidden rounded-[var(--radius-group)] bg-surface">
				<video
					aria-label="warden batch leasing five iOS simulators and running salient's end-to-end flows across them"
					autoPlay={!reduced}
					className="block h-auto w-full"
					controls={reduced}
					loop
					muted
					playsInline
					poster={`${SRC}/poster.jpg`}
					preload="metadata"
					ref={ref}
				>
					<source src={`${SRC}/demo.webm`} type="video/webm" />
					<source src={`${SRC}/demo.mp4`} type="video/mp4" />
				</video>
			</div>
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-ink-2 text-sm">
				<code className="font-mono text-ink">warden batch salient-e2e</code>
				<span className="font-mono tabular-nums">
					37 Salient e2e flows · 5 iPhone 17 simulators · 3m25s (13m55s on one) · 37/37 passed · shown at 5× speed
				</span>
			</figcaption>
		</figure>
	);
}
