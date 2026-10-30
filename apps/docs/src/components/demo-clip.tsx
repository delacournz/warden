import { type ReactElement, useEffect, useRef } from "react";
import { useReducedMotion } from "@/components/landing/demo-video";

/**
 * A recorded demo in a docs page (`public/demos/<feature>/<clip>.{mp4,jpg}`, pass `src` without the extension). It
 * autoplays muted and loops, with controls to pause; with reduced motion it rests on the poster (the end state) until
 * played. `label` names what the clip shows for screen readers.
 */
export function DemoClip({ src, label }: { src: string; label: string }): ReactElement {
	const reduced = useReducedMotion();
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		if (reduced) video.pause();
		else void video.play().catch(() => undefined);
	}, [reduced]);
	return (
		<video
			aria-label={label}
			autoPlay={!reduced}
			className="w-full rounded-lg"
			controls
			loop
			muted
			playsInline
			poster={`${src}.jpg`}
			preload="metadata"
			ref={ref}
		>
			<source src={`${src}.mp4`} type="video/mp4" />
		</video>
	);
}
