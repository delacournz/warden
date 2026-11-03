import { type ReactElement, useEffect, useRef } from "react";
import { ClipTabs } from "@/components/landing/clip-tabs";
import { useReducedMotion } from "@/components/landing/demo-video";
import { DEVICE_CONTROL } from "@/lib/landing.data";

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

/**
 * Several device-control clips as tabs at the top of a docs page: the landing's clips (same videos and captions,
 * picked by id in the order given), without the Read more that would point back at the page.
 */
export function DemoTabs({ ids }: { ids: readonly string[] }): ReactElement {
	const clips = ids.flatMap((id) => DEVICE_CONTROL.clips.filter((clip) => clip.id === id));
	return (
		<div className="not-prose my-6">
			<ClipTabs clips={clips} readMore={false} />
		</div>
	);
}
