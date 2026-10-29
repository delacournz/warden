import { type RefObject, useEffect, useState } from "react";
import { type StreamStatus, startWhepSession } from "./whep-session.ts";

export type VideoSize = { width: number; height: number };

/** Run a WHEP session into `videoRef` for the life of the component and report status and picture size. */
export function useWhep(videoRef: RefObject<HTMLVideoElement | null>): {
	status: StreamStatus;
	size: VideoSize | null;
	error: string | null;
} {
	const [status, setStatus] = useState<StreamStatus>("connecting");
	const [size, setSize] = useState<VideoSize | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		const onSize = () => {
			if (video.videoWidth > 0 && video.videoHeight > 0) {
				setSize({ width: video.videoWidth, height: video.videoHeight });
			}
		};
		video.addEventListener("loadedmetadata", onSize);
		video.addEventListener("resize", onSize);
		const stop = startWhepSession(video, { onStatus: setStatus, onError: setError });
		return () => {
			video.removeEventListener("loadedmetadata", onSize);
			video.removeEventListener("resize", onSize);
			stop();
		};
	}, [videoRef]);

	return { status, size, error };
}
