import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { RichText } from "@/components/rich-text";
import { cn } from "@/lib/cn";
import type { Clip } from "@/lib/landing.data";
import { useReducedMotion } from "./demo-video";

/**
 * The device-control clips as tabs: each a real simulator driven by the commands its caption names. Arrow keys move
 * between tabs, as in `InstallCommand`. The selected clip autoplays muted and loops; with reduced motion it rests on
 * its poster (the end state) with controls. A tab change remounts the video so it starts from the beginning. `readMore`
 * off drops the link, for a docs page that is itself the clip's Read more.
 */
export function ClipTabs({
	clips,
	readMore = true,
}: {
	clips: readonly Clip[];
	readMore?: boolean;
}): ReactElement | null {
	const [selected, setSelected] = useState(0);
	const reduced = useReducedMotion();
	const id = useId();
	const tabs = useRef<Array<HTMLButtonElement | null>>([]);
	const video = useRef<HTMLVideoElement>(null);
	const clip = clips[selected] ?? clips[0];

	useEffect(() => {
		const el = video.current;
		if (!el) return;
		if (reduced) el.pause();
		else void el.play().catch(() => undefined);
	}, [reduced]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const next = (selected + step + clips.length) % clips.length;
		setSelected(next);
		tabs.current[next]?.focus();
	};

	if (!clip) return null;

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
			<div
				aria-label="Device condition"
				className="flex flex-wrap justify-center gap-1"
				onKeyDown={onKeyDown}
				role="tablist"
			>
				{clips.map((c, i) => (
					<button
						aria-controls={`${id}-panel`}
						aria-selected={i === selected}
						className={cn(
							"rounded-full px-4 py-1.5 font-mono text-xs transition-colors",
							i === selected ? "bg-fill text-ink" : "text-ink-2 hover:text-ink"
						)}
						id={`${id}-${c.id}`}
						key={c.id}
						onClick={() => setSelected(i)}
						ref={(el) => {
							tabs.current[i] = el;
						}}
						role="tab"
						tabIndex={i === selected ? 0 : -1}
						type="button"
					>
						{c.tab}
					</button>
				))}
			</div>
			<figure aria-labelledby={`${id}-${clip.id}`} className="flex flex-col gap-3" id={`${id}-panel`} role="tabpanel">
				<div className="overflow-hidden rounded-[var(--radius-group)] bg-surface">
					<video
						aria-label={`${clip.title} Recorded on a leased simulator.`}
						autoPlay={!reduced}
						className="block aspect-video h-auto w-full"
						controls={reduced}
						key={clip.id}
						loop
						muted
						playsInline
						poster={`${clip.src}.jpg`}
						preload="metadata"
						ref={video}
					>
						<source src={`${clip.src}.mp4`} type="video/mp4" />
					</video>
				</div>
				<figcaption className="flex flex-col gap-x-6 gap-y-2 text-start text-ink-2 text-sm leading-relaxed sm:flex-row sm:items-baseline sm:justify-between">
					<span className="max-w-[68ch]">
						<RichText text={clip.caption} />
					</span>
					{readMore ? (
						<Link
							className="shrink-0 font-mono text-[11px] text-ink uppercase tracking-[0.12em] hover:text-accent-text"
							params={{ _splat: clip.href }}
							to="/docs/$"
						>
							Read more →
						</Link>
					) : null}
				</figcaption>
			</figure>
		</div>
	);
}
