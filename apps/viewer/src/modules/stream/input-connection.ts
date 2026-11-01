import type { InputEvent, InputFrame } from "../../core/api/device.api.ts";
import { backoffDelay } from "./whep.ts";

type InputApi = {
	connect: (onEvent: (event: InputEvent) => void) => Promise<void>;
	send: (frame: InputFrame) => Promise<void>;
	close: () => Promise<void>;
};

type InputConnectionOptions = {
	api: InputApi;
	onReadyChange: (ready: boolean) => void;
	onError: (message: string) => void;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
};

export type InputConnection = {
	start: () => void;
	stop: () => void;
	isReady: () => boolean;
	send: (frame: InputFrame) => Promise<void>;
};

/**
 * Owns the live input socket's lifecycle: ready on the `ready` event, not ready on `closed` or a
 * failed connect, and a reconnect with the shared backoff (1s doubling, 15s cap) until `stop`. A
 * `ready` resets the backoff. Server `error` events go to `onError`. Side effects are injected.
 */
export function createInputConnection(options: InputConnectionOptions): InputConnection {
	const { api, onReadyChange, onError, setTimer, clearTimer } = options;
	let ready = false;
	let stopped = true;
	let attempt = 0;
	let timer: unknown = null;

	const setReady = (next: boolean) => {
		if (ready === next) return;
		ready = next;
		onReadyChange(next);
	};

	const scheduleRetry = () => {
		if (stopped) return;
		const delay = backoffDelay(attempt);
		attempt += 1;
		timer = setTimer(() => {
			timer = null;
			connect();
		}, delay);
	};

	const onEvent = (event: InputEvent) => {
		if (stopped) return;
		if (event.type === "ready") {
			attempt = 0;
			setReady(true);
		} else if (event.type === "closed") {
			setReady(false);
			scheduleRetry();
		} else if (event.type === "error") {
			onError(event.message);
		}
	};

	const connect = () => {
		api.connect(onEvent).catch(() => {
			setReady(false);
			scheduleRetry();
		});
	};

	return {
		start() {
			if (!stopped) return;
			stopped = false;
			attempt = 0;
			connect();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			if (timer !== null) clearTimer(timer);
			timer = null;
			setReady(false);
			api.close().catch(() => undefined);
		},
		isReady: () => ready,
		send: (frame) => api.send(frame),
	};
}
