import { type RefObject, useEffect, useState } from "react";
import { type StreamError, type StreamStatus, startWhepSession } from "./whep-session.ts";

export type VideoSize = { width: number; height: number };

/**
 * Run a WHEP session into `videoRef` while `enabled`, and report status, picture size and the last
 * error. Turning `enabled` off closes the stream.
 */
export function useWhep(
	videoRef: RefObject<HTMLVideoElement | null>,
	enabled: boolean
): {
	status: StreamStatus;
	size: VideoSize | null;
	error: StreamError | null;
} {
	const [status, setStatus] = useState<StreamStatus>("connecting");
	const [size, setSize] = useState<VideoSize | null>(null);
	const [error, setError] = useState<StreamError | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !enabled) return;
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
	}, [videoRef, enabled]);

	return { status, size, error };
}
