import { type KeyboardEvent, type ReactElement, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "./landing/demo-video";

/**
 * A recorded clip with no player chrome: `public/<src>.{mp4,jpg}`, muted, looping. It autoplays unless the visitor
 * prefers reduced motion, then rests on its poster (the end state). Clicking it, or Space / Enter while it has focus,
 * pauses and resumes, so a looping clip can always be stopped without the browser's controls bar over the recording.
 */
export function QuietVideo({
	src,
	label,
	className,
}: {
	src: string;
	label: string;
	className?: string;
}): ReactElement {
	const reduced = useReducedMotion();
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		if (reduced) video.pause();
		else void video.play().catch(() => undefined);
	}, [reduced]);

	const toggle = () => {
		const video = ref.current;
		if (!video) return;
		if (video.paused) void video.play().catch(() => undefined);
		else video.pause();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLVideoElement>) => {
		if (event.key !== " " && event.key !== "Enter") return;
		event.preventDefault();
		toggle();
	};

	return (
		<video
			aria-label={`${label} Click to pause or play.`}
			autoPlay={!reduced}
			className={cn(
				"cursor-pointer focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2",
				className
			)}
			loop
			muted
			onClick={toggle}
			onKeyDown={onKeyDown}
			playsInline
			poster={`${src}.jpg`}
			preload="metadata"
			ref={ref}
			tabIndex={0}
		>
			<source src={`${src}.mp4`} type="video/mp4" />
		</video>
	);
}
