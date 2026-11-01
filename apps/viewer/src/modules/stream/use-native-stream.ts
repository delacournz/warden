import { type RefObject, useEffect, useState } from "react";
import { startNativeSession } from "./native-session.ts";
import type { VideoSize } from "./use-whep.ts";
import type { StreamError, StreamStatus } from "./whep-session.ts";

/**
 * Run a native stream session into `canvasRef` while `enabled`, with the same status, size and
 * error shape as `useWhep`. Turning `enabled` off closes the stream.
 */
export function useNativeStream(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	enabled: boolean
): { status: StreamStatus; size: VideoSize | null; error: StreamError | null } {
	const [status, setStatus] = useState<StreamStatus>("connecting");
	const [size, setSize] = useState<VideoSize | null>(null);
	const [error, setError] = useState<StreamError | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !enabled) return;
		return startNativeSession(canvas, { onStatus: setStatus, onError: setError, onSize: setSize });
	}, [canvasRef, enabled]);

	return { status, size, error };
}
