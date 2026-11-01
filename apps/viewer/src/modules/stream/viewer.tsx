import { getCurrentWindow } from "@tauri-apps/api/window";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import * as device from "../../core/api/device.api.ts";
import { type Screen, useDeviceInput } from "../input/use-device-input.ts";
import { logActions } from "../interaction/device-actions.ts";
import { InteractionLayer } from "../interaction/interaction-layer.tsx";
import { actionAvailability } from "../toolbar/availability.ts";
import { DeviceControls } from "../toolbar/device-controls.tsx";
import { CHROME_HEIGHT, CHROME_WIDTH, SCREEN_INSET } from "../toolbar/layout.ts";
import { Titlebar } from "../toolbar/titlebar.tsx";
import { overlayFor } from "./billing-state.ts";
import { asksOnClose } from "./close-intent.ts";
import { ClosePrompt } from "./close-prompt.tsx";
import { DemoOrbHint } from "./demo-orb-hint.tsx";
import { StoppedState } from "./stopped-state.tsx";
import { StreamState } from "./stream-state.tsx";
import { type Ripple, TapRipples } from "./tap-ripples.tsx";
import { useBilling } from "./use-billing.ts";
import { useDeviceStream } from "./use-device-stream.ts";
import type { StreamStatus } from "./whep-session.ts";
import { needsRefit } from "./window-fit.ts";

const NOTICE_VISIBLE_MS = 4000;

/**
 * Switch for the stub interaction layer (touch visuals, right-click menu, typing mode). It runs
 * beside the real tap path in `useDeviceInput`: both see every press, the layer only logs.
 */
const INTERACTION_LAYER = true;

/** Screen corner radius that echoes the platform's hardware. */
const SCREEN_RADIUS = { ios: "rounded-[26px]", android: "rounded-[16px]" } as const;

/** Cmd/Ctrl+W closes and Cmd/Ctrl+M minimizes, since an undecorated window has no native menu. */
function useWindowShortcuts(close: () => void, minimize: () => void) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
			const key = event.key.toLowerCase();
			if (key === "w") close();
			else if (key === "m") minimize();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close, minimize]);
}

/** Ripples at the pointer, relative to the element pressed; at most five live at once. */
function useRipples() {
	const [ripples, setRipples] = useState<Ripple[]>([]);
	const counter = useRef(0);
	const addRipple = (event: PointerEvent<HTMLElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		counter.current += 1;
		const next = { id: counter.current, x: event.clientX - box.left, y: event.clientY - box.top };
		setRipples((current) => [...current.slice(-4), next]);
	};
	const removeRipple = (id: number) => setRipples((current) => current.filter((r) => r.id !== id));
	return { ripples, addRipple, removeRipple };
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * The whole window: a rounded surface holding one slim bar and the device screen. The first frame
 * resizes the window to the device aspect (again on rotation; Rust then holds that ratio through
 * user resizes) and tells the CLI the stream is up. With a view-scope
 * session, or the toggle on watch, the screen is inert; in drive mode it gets a ring, a pointer
 * cursor and a ripple where you press. Non-streaming states are a calm overlay on the screen, and
 * Cmd/Ctrl+W closes while Cmd/Ctrl+M minimizes, since there is no native menu. Closing an attached
 * viewer on a live device asks first: keep the device running, or shut it down and release the lease.
 */
export function Viewer({ info, expired }: { info: device.ViewerInfo; expired: boolean }) {
	const billing = useBilling();
	const overlay = overlayFor(expired, billing);
	const { native, demo, videoRef, canvasRef, status: streamStatus, size, error } = useDeviceStream(overlay === null);
	const status: StreamStatus = overlay === "expired" ? "expired" : overlay ? "stopped" : streamStatus;
	const [driving, setDriving] = useState(info.scope === "drive");
	const [pinned, setPinned] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const announced = useRef(false);
	const fitted = useRef<number | null>(null);
	const { ripples, addRipple, removeRipple } = useRipples();
	const canDrive = info.scope === "drive" && driving && status === "streaming";

	const showNotice = useCallback((text: string) => setNotice(text), []);
	const handlers = useDeviceInput(info.scope === "drive" && driving, showNotice);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		if (!size) return;
		const aspect = size.width / size.height;
		if (needsRefit(fitted.current, aspect)) {
			fitted.current = aspect;
			device.fitWindow(aspect, CHROME_HEIGHT, CHROME_WIDTH).catch(() => undefined);
		}
		if (announced.current) return;
		announced.current = true;
		device.viewerStreaming().catch(() => undefined);
	}, [size]);

	const [closing, setClosing] = useState<"asking" | "busy" | null>(null);
	const asks = asksOnClose(info.detached, overlay);
	const close = useCallback(() => {
		if (asks) setClosing((current) => current ?? "asking");
		else void getCurrentWindow().close();
	}, [asks]);
	const finishClose = (release: boolean) => {
		setClosing("busy");
		device.closeViewer(release).catch((e: unknown) => {
			setClosing(null);
			showNotice(message(e));
		});
	};
	const cancelClose = useCallback(() => setClosing(null), []);
	const minimize = useCallback(() => void getCurrentWindow().minimize(), []);

	useWindowShortcuts(close, minimize);

	const run = (action: Promise<unknown>) => action.catch((e: unknown) => showNotice(message(e)));

	const onPinnedChange = (next: boolean) => {
		setPinned(next);
		void run(getCurrentWindow().setAlwaysOnTop(next));
	};

	const onPointerDown = (event: PointerEvent<Screen>) => {
		handlers.onPointerDown(event);
		if (canDrive) addRipple(event);
	};

	const topUp = () => void run(device.openBilling());

	const unreachable = error?.code === "UNREACHABLE";
	const availability = actionAvailability(status, unreachable);
	const ring = canDrive ? "ring-1 ring-primary/50" : "ring-1 ring-border";

	return (
		<div className="flex h-svh flex-col rounded-[14px] bg-background text-foreground">
			<Titlebar
				title={info.title}
				scope={info.scope}
				driving={driving}
				onDrivingChange={setDriving}
				status={status}
				availability={availability}
				pinned={pinned}
				onPinnedChange={onPinnedChange}
				lowBalance={billing.lowBalance && info.hasBillingUrl}
				onTopUp={topUp}
				onOpenUrl={(url) => void run(device.openUrl(url))}
				onScreenshot={() => void run(device.screenshot())}
				onMinimize={minimize}
				onClose={close}
				deviceControls={<DeviceControls actions={logActions} disabledReason={availability.reason} />}
			/>
			<div className="min-h-0 flex-1" style={{ padding: `0 ${SCREEN_INSET}px ${SCREEN_INSET}px` }}>
				<InteractionLayer
					enabled={INTERACTION_LAYER && canDrive}
					className={`relative h-full overflow-hidden bg-black ${SCREEN_RADIUS[info.platform]} ${ring}`}
					style={{ cursor: canDrive ? "pointer" : "default" }}
				>
					{native ? (
						<canvas
							ref={canvasRef}
							className="h-full w-full touch-none select-none object-contain"
							onPointerDown={onPointerDown}
							onPointerUp={handlers.onPointerUp}
							onWheel={handlers.onWheel}
						/>
					) : (
						<video
							ref={videoRef}
							className="h-full w-full touch-none select-none object-contain"
							autoPlay
							muted
							playsInline
							onPointerDown={onPointerDown}
							onPointerUp={handlers.onPointerUp}
							onWheel={handlers.onWheel}
						/>
					)}
					<TapRipples ripples={ripples} onDone={removeRipple} />
					{demo && size && <DemoOrbHint size={size} />}
					<StreamState status={status} unreachable={unreachable} />
					{(overlay === "out-of-credits" || overlay === "stopped") && (
						<StoppedState overlay={overlay} hasBillingUrl={info.hasBillingUrl} onTopUp={topUp} />
					)}
					{closing && (
						<ClosePrompt
							busy={closing === "busy"}
							onKeep={() => finishClose(false)}
							onShutDown={() => finishClose(true)}
							onCancel={cancelClose}
						/>
					)}
					{notice && (
						<p
							role="alert"
							className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md/5"
						>
							{notice}
						</p>
					)}
				</InteractionLayer>
			</div>
		</div>
	);
}
