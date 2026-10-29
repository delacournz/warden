import { Spinner } from "@delacournz/apogee/spinner";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import * as device from "../../core/api/device.api.ts";
import { useDeviceInput } from "../input/use-device-input.ts";
import { TOOLBAR_HEIGHT, Toolbar } from "../toolbar/toolbar.tsx";
import { useWhep } from "./use-whep.ts";

const ERROR_VISIBLE_MS = 4000;

/**
 * The whole window: toolbar above a letterboxed video. The first frame resizes the window to the
 * device aspect and tells the CLI the stream is up. With a view-scope session, or the toggle on
 * watch, the video is inert.
 */
export function Viewer({ info }: { info: device.ViewerInfo }) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const { status, size, error } = useWhep(videoRef);
	const [driving, setDriving] = useState(info.scope === "drive");
	const [actionError, setActionError] = useState<string | null>(null);
	const announced = useRef(false);

	const showError = useCallback((message: string) => setActionError(message), []);
	const handlers = useDeviceInput(info.scope === "drive" && driving, showError);

	useEffect(() => {
		if (!actionError) return;
		const timer = setTimeout(() => setActionError(null), ERROR_VISIBLE_MS);
		return () => clearTimeout(timer);
	}, [actionError]);

	useEffect(() => {
		if (!size || announced.current) return;
		announced.current = true;
		device.fitWindow(size.width / size.height, TOOLBAR_HEIGHT).catch(() => undefined);
		device.viewerStreaming().catch(() => undefined);
	}, [size]);

	const run = (action: Promise<unknown>) =>
		action.catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
	const message = actionError ?? error;

	return (
		<div className="flex h-svh flex-col bg-background text-foreground">
			<Toolbar
				scope={info.scope}
				driving={driving}
				onDrivingChange={setDriving}
				status={status}
				onOpenUrl={(url) => void run(device.openUrl(url))}
				onScreenshot={() => void run(device.screenshot())}
				onTopChange={(onTop) => void run(getCurrentWindow().setAlwaysOnTop(onTop))}
			/>
			<div className="relative min-h-0 flex-1 bg-black">
				<video
					ref={videoRef}
					className="h-full w-full touch-none select-none object-contain"
					style={{ cursor: info.scope === "drive" && driving ? "pointer" : "default" }}
					autoPlay
					muted
					playsInline
					onPointerDown={handlers.onPointerDown}
					onPointerUp={handlers.onPointerUp}
					onWheel={handlers.onWheel}
				/>
				{status !== "streaming" && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
						<Spinner />
					</div>
				)}
				{message && (
					<div
						className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-destructive/90 px-3 py-2 text-xs text-white"
						role="alert"
					>
						{message}
					</div>
				)}
			</div>
		</div>
	);
}
