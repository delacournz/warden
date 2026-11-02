import { Camera, Coins, Eye, HandPointing, Minus, PushPin, X } from "@phosphor-icons/react";
import type { Scope } from "../../core/api/device.api.ts";
import type { StreamStatus } from "../stream/whep-session.ts";
import type { Availability } from "./availability.ts";
import { IconButton, IconToggle } from "./icon-button.tsx";
import { TITLEBAR_HEIGHT } from "./layout.ts";
import { OpenUrlAction } from "./open-url-action.tsx";

const STATUS = {
	connecting: { dot: "bg-warning animate-pulse motion-reduce:animate-none", label: "Connecting" },
	reconnecting: { dot: "bg-warning animate-pulse motion-reduce:animate-none", label: "Retrying" },
	streaming: { dot: "bg-success", label: "Live" },
	expired: { dot: "bg-muted-foreground", label: "Expired" },
	stopped: { dot: "bg-muted-foreground", label: "Stopped" },
} as const satisfies Record<StreamStatus, { dot: string; label: string }>;

type TitlebarProps = {
	title: string;
	scope: Scope;
	driving: boolean;
	onDrivingChange: (driving: boolean) => void;
	status: StreamStatus;
	availability: Availability;
	pinned: boolean;
	onPinnedChange: (pinned: boolean) => void;
	lowBalance: boolean;
	onTopUp: () => void;
	onOpenUrl: (url: string) => void;
	onScreenshot: () => void;
	onMinimize: () => void;
	onClose: () => void;
};

/**
 * The one bar that replaces the native title bar and toolbar. The bar and its non-interactive
 * children carry `data-tauri-drag-region` (children are `pointer-events-none` so presses fall through
 * to the bar) and show a grab cursor, while the button groups keep the default one. Layout: device title, connection dot and label,
 * a quiet low-balance badge (click to top up) when the viewer has a billing URL, the actions (quiet until the window is hovered or focused), then the window controls. A view-scope
 * session gets no open-URL or drive controls.
 */
export function Titlebar({
	title,
	scope,
	driving,
	onDrivingChange,
	status,
	availability,
	pinned,
	onPinnedChange,
	lowBalance,
	onTopUp,
	onOpenUrl,
	onScreenshot,
	onMinimize,
	onClose,
}: TitlebarProps) {
	const state = STATUS[status];

	return (
		<header
			data-tauri-drag-region
			className="group/bar flex shrink-0 cursor-grab select-none items-center gap-1 pr-1.5 pl-3 active:cursor-grabbing"
			style={{ height: TITLEBAR_HEIGHT }}
		>
			<h1 className="pointer-events-none min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">{title}</h1>
			<div className="pointer-events-none flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-muted-foreground">
				<span className={`size-1.5 rounded-full ${state.dot}`} />
				<span>{state.label}</span>
			</div>
			{lowBalance && (
				<button
					type="button"
					onClick={onTopUp}
					className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning-foreground hover:bg-warning/25"
				>
					<Coins size={12} />
					Low balance · top up
				</button>
			)}
			<div
				role="toolbar"
				aria-label="Device actions"
				className="flex cursor-default items-center gap-0.5 opacity-60 transition-opacity duration-150 group-focus-within/bar:opacity-100 group-hover/bar:opacity-100 motion-reduce:transition-none"
			>
				{scope === "drive" && <OpenUrlAction onOpenUrl={onOpenUrl} disabledReason={availability.reason} />}
				<IconButton label="Save screenshot" onClick={onScreenshot} disabledReason={availability.reason}>
					<Camera />
				</IconButton>
				{scope === "drive" && (
					<IconToggle
						label={driving ? "Driving. Switch to watching" : "Watching. Switch to driving"}
						pressed={driving}
						onPressedChange={onDrivingChange}
						disabledReason={availability.reason}
					>
						{driving ? <HandPointing /> : <Eye />}
					</IconToggle>
				)}
			</div>
			<span aria-hidden className="pointer-events-none mx-1 h-3.5 w-px bg-border" data-tauri-drag-region />
			<div role="toolbar" aria-label="Window controls" className="flex cursor-default items-center gap-0.5">
				<IconToggle label={pinned ? "Unpin from top" : "Keep on top"} pressed={pinned} onPressedChange={onPinnedChange}>
					<PushPin />
				</IconToggle>
				<IconButton label="Minimize" onClick={onMinimize}>
					<Minus />
				</IconButton>
				<IconButton label="Close" onClick={onClose} destructive>
					<X />
				</IconButton>
			</div>
		</header>
	);
}
