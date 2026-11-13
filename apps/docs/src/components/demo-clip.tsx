import type { ReactElement } from "react";
import { ClipTabs } from "@/components/landing/clip-tabs";
import { QuietVideo } from "@/components/quiet-video";
import { DEVICE_CONTROL } from "@/lib/landing.data";

/**
 * A recorded demo in a docs page (`public/demos/<feature>/<clip>.{mp4,jpg}`, pass `src` without the extension), with
 * no player chrome: see {@link QuietVideo}. `label` names what the clip shows for screen readers.
 */
export function DemoClip({ src, label }: { src: string; label: string }): ReactElement {
	return <QuietVideo className="w-full rounded-lg" label={label} src={src} />;
}

/**
 * Several device-control clips as tabs at the top of a docs page: the landing's clips (same videos and captions,
 * picked by id in the order given), without the Read more that would point back at the page and without player
 * chrome.
 */
export function DemoTabs({ ids }: { ids: readonly string[] }): ReactElement {
	const clips = ids.flatMap((id) => DEVICE_CONTROL.clips.filter((clip) => clip.id === id));
	return (
		<div className="not-prose my-6">
			<ClipTabs clips={clips} controls={false} readMore={false} />
		</div>
	);
}
