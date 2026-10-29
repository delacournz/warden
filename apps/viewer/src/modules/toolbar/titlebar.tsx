import { Button } from "@delacournz/apogee/button";
import { Input } from "@delacournz/apogee/input";
import { Popover, PopoverContent, PopoverTrigger } from "@delacournz/apogee/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@delacournz/apogee/tooltip";
import { Camera, Eye, HandPointing, Link, Minus, PushPin, X } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import type { Scope } from "../../core/api/device.api.ts";
import type { StreamStatus } from "../stream/whep-session.ts";
import { IconButton, IconToggle } from "./icon-button.tsx";
import { TITLEBAR_HEIGHT } from "./layout.ts";
import { normalizeUrl } from "./url.ts";

const STATUS = {
	connecting: { dot: "bg-warning animate-pulse motion-reduce:animate-none", label: "Connecting" },
	reconnecting: { dot: "bg-warning animate-pulse motion-reduce:animate-none", label: "Retrying" },
	streaming: { dot: "bg-success", label: "Live" },
	expired: { dot: "bg-muted-foreground", label: "Expired" },
} as const satisfies Record<StreamStatus, { dot: string; label: string }>;

type TitlebarProps = {
	title: string;
	scope: Scope;
	driving: boolean;
	onDrivingChange: (driving: boolean) => void;
	status: StreamStatus;
	pinned: boolean;
	onPinnedChange: (pinned: boolean) => void;
	onOpenUrl: (url: string) => void;
	onScreenshot: () => void;
	onMinimize: () => void;
	onClose: () => void;
};

/**
 * The one bar that replaces the native title bar and toolbar. The bar and its non-interactive
 * children carry `data-tauri-drag-region` (children are `pointer-events-none` so presses fall through
 * to the bar), while buttons stay clickable. Layout: device title, connection dot and label,
 * the actions (quiet until the window is hovered or focused), then the window controls. A view-scope
 * session gets no open-URL or drive controls.
 */
export function Titlebar({
	title,
	scope,
	driving,
	onDrivingChange,
	status,
	pinned,
	onPinnedChange,
	onOpenUrl,
	onScreenshot,
	onMinimize,
	onClose,
}: TitlebarProps) {
	const [url, setUrl] = useState("");
	const [open, setOpen] = useState(false);
	const state = STATUS[status];
	const target = normalizeUrl(url);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!target) return;
		onOpenUrl(target);
		setUrl("");
		setOpen(false);
	};

	return (
		<header
			data-tauri-drag-region
			className="group/bar flex shrink-0 select-none items-center gap-1 pr-1.5 pl-3"
			style={{ height: TITLEBAR_HEIGHT }}
		>
			<h1 className="pointer-events-none min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">{title}</h1>
			<div className="pointer-events-none flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-muted-foreground">
				<span className={`size-1.5 rounded-full ${state.dot}`} />
				<span>{state.label}</span>
			</div>
			<div
				role="toolbar"
				aria-label="Device actions"
				className="flex items-center gap-0.5 opacity-60 transition-opacity duration-150 group-focus-within/bar:opacity-100 group-hover/bar:opacity-100 motion-reduce:transition-none"
			>
				{scope === "drive" && (
					<Popover open={open} onOpenChange={setOpen}>
						<Tooltip>
							<TooltipTrigger
								render={
									<PopoverTrigger
										render={
											<Button
												variant="ghost"
												size="icon-xs"
												aria-label="Open URL on device"
												className="text-muted-foreground hover:text-foreground"
											/>
										}
									/>
								}
							>
								<Link />
							</TooltipTrigger>
							<TooltipContent side="bottom">Open URL on device</TooltipContent>
						</Tooltip>
						<PopoverContent align="end" sideOffset={8}>
							<form className="flex w-72 flex-col gap-2" onSubmit={submit}>
								<label htmlFor="open-url" className="text-xs font-medium">
									Open a URL on the device
								</label>
								<div className="flex gap-2">
									<Input
										id="open-url"
										size="sm"
										placeholder="example.com or app://path"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										autoComplete="off"
										autoCorrect="off"
										spellCheck={false}
										autoFocus
									/>
									<Button type="submit" size="sm" disabled={!target}>
										Open
									</Button>
								</div>
							</form>
						</PopoverContent>
					</Popover>
				)}
				<IconButton label="Save screenshot" onClick={onScreenshot}>
					<Camera />
				</IconButton>
				{scope === "drive" && (
					<IconToggle
						label={driving ? "Driving. Switch to watching" : "Watching. Switch to driving"}
						pressed={driving}
						onPressedChange={onDrivingChange}
					>
						{driving ? <HandPointing /> : <Eye />}
					</IconToggle>
				)}
			</div>
			<span aria-hidden className="pointer-events-none mx-1 h-3.5 w-px bg-border" data-tauri-drag-region />
			<div role="toolbar" aria-label="Window controls" className="flex items-center gap-0.5">
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
