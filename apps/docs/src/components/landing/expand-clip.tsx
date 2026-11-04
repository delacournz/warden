import { type ReactElement, type RefObject, useRef, useState } from "react";
import { QuietVideo } from "@/components/quiet-video";

/** iOS Safari's video-only fullscreen, which `requestFullscreen` does not cover on iPhone. */
interface WebkitFullscreenVideo extends HTMLVideoElement {
	webkitEnterFullscreen?: () => void;
}

/** The pill shared by the clip controls. */
export const CLIP_CHIP =
	"rounded-full border border-hairline px-3 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2";

/** Touch or a narrow window: where a clip in a modal is no bigger than the page, so native fullscreen is the way. */
function prefersNativeFullscreen(): boolean {
	return window.matchMedia("(pointer: coarse), (max-width: 767px)").matches;
}

/**
 * Enters native fullscreen on the `<video>` inside `container`, so a phone can rotate to landscape and the 16:9 clip
 * fills the screen. Standard `requestFullscreen` first, then iOS Safari's `webkitEnterFullscreen`. Resolves `false`
 * when neither exists or the request is refused, and the caller falls back to the dialog.
 */
async function enterNativeFullscreen(container: HTMLElement | null): Promise<boolean> {
	const video = container?.querySelector("video") as WebkitFullscreenVideo | null;
	if (!video) return false;
	try {
		if (video.requestFullscreen) {
			await video.requestFullscreen();
			return true;
		}
		if (video.webkitEnterFullscreen) {
			video.webkitEnterFullscreen();
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * An "expand" button for a recorded clip. On touch or narrow viewports it puts the clip's `<video>` (found inside
 * `container`) into native fullscreen; on desktop it opens a modal `<dialog>` up to the render's own 1920px, capped to
 * the viewport height. The dialog is native: `showModal` traps focus and restores it on close, Esc and a backdrop click
 * close it, and it has no animation, so reduced motion needs no special case. `src` is the clip's path without
 * extension, as for {@link QuietVideo}.
 */
export function ExpandClip({
	src,
	label,
	container,
}: {
	src: string;
	label: string;
	container: RefObject<HTMLElement | null>;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);

	const expand = async () => {
		if (prefersNativeFullscreen() && (await enterNativeFullscreen(container.current))) return;
		setOpen(true);
		dialog.current?.showModal();
	};
	const close = () => {
		dialog.current?.close();
	};

	return (
		<>
			<button aria-label={`Expand clip: ${label}`} className={CLIP_CHIP} onClick={() => void expand()} type="button">
				expand
			</button>
			<dialog
				aria-label={label}
				className="m-auto w-[min(96vw,1920px,calc((100dvh-5rem)*1.7778))] max-w-none overflow-visible bg-transparent p-0 backdrop:bg-black/80"
				onClick={(event) => {
					if (event.target === event.currentTarget) close();
				}}
				onClose={() => setOpen(false)}
				ref={dialog}
			>
				{open ? (
					<div className="flex flex-col gap-3">
						<div className="flex justify-end">
							<button
								aria-label="Close expanded clip"
								className={`${CLIP_CHIP} bg-surface`}
								onClick={close}
								type="button"
							>
								close · esc
							</button>
						</div>
						<QuietVideo
							className="w-full rounded-[var(--radius-group)] border border-hairline"
							label={label}
							src={src}
						/>
					</div>
				) : null}
			</dialog>
		</>
	);
}
