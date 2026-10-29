import { createFileRoute } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { type ViewerInfo, viewerInfo } from "../core/api/device.api.ts";
import { Expired } from "../modules/stream/expired.tsx";
import { Viewer } from "../modules/stream/viewer.tsx";

/**
 * Loads the session info from Rust once, then mounts the viewer. When Rust reports a detached
 * session's token expired, the viewer unmounts, which closes the stream, and the expired state
 * takes its place.
 */
function Home() {
	const [info, setInfo] = useState<ViewerInfo | null>(null);
	const [expired, setExpired] = useState(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let disposed = false;
		listen("viewer-expired", () => setExpired(true)).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		viewerInfo().then(
			(i) => {
				setInfo(i);
				if (i.expired) setExpired(true);
			},
			() => undefined
		);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	if (expired) return <Expired />;
	return info ? <Viewer info={info} /> : null;
}

export const Route = createFileRoute("/")({ component: Home });
