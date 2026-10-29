import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type ViewerInfo, viewerInfo } from "../core/api/device.api.ts";
import { Viewer } from "../modules/stream/viewer.tsx";

/** Loads the session info from Rust once, then mounts the viewer. */
function Home() {
	const [info, setInfo] = useState<ViewerInfo | null>(null);

	useEffect(() => {
		viewerInfo().then(setInfo, () => undefined);
	}, []);

	return info ? <Viewer info={info} /> : null;
}

export const Route = createFileRoute("/")({ component: Home });
