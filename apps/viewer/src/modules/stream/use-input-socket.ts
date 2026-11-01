import { useEffect, useMemo, useState } from "react";
import * as device from "../../core/api/device.api.ts";
import type { LiveInput } from "../interaction/device-actions.ts";
import { createInputConnection } from "./input-connection.ts";

/**
 * Holds the live input socket while `enabled` (drive scope and streaming): connects on enable,
 * reconnects with backoff, closes on disable or unmount. `live` is stable across renders so the
 * memoised device actions never rebuild; `ready` drives UI such as the Rotate button. Server error
 * events go to `onError`.
 */
export function useInputSocket(enabled: boolean, onError: (message: string) => void) {
	const [ready, setReady] = useState(false);
	const connection = useMemo(
		() =>
			createInputConnection({
				api: { connect: device.inputConnect, send: device.inputSend, close: device.inputClose },
				onReadyChange: setReady,
				onError,
				setTimer: (fn, ms) => setTimeout(fn, ms),
				clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			}),
		[onError]
	);
	const live = useMemo<LiveInput>(() => ({ ready: connection.isReady, send: connection.send }), [connection]);

	useEffect(() => {
		if (!enabled) return;
		connection.start();
		return () => connection.stop();
	}, [enabled, connection]);

	return { live, ready };
}
