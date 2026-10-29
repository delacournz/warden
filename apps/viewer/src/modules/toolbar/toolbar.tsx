import { Badge } from "@delacournz/apogee/badge";
import { Button } from "@delacournz/apogee/button";
import { Input } from "@delacournz/apogee/input";
import { Popover, PopoverContent, PopoverTrigger } from "@delacournz/apogee/popover";
import { Toggle } from "@delacournz/apogee/toggle";
import { Camera, Eye, HandPointing, Link, PushPin } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import type { Scope } from "../../core/api/device.api.ts";
import type { StreamStatus } from "../stream/whep-session.ts";

export const TOOLBAR_HEIGHT = 40;

const STATUS_BADGE = {
	connecting: { variant: "warning", label: "Connecting" },
	streaming: { variant: "success", label: "Live" },
	reconnecting: { variant: "warning", label: "Reconnecting" },
} as const;

type ToolbarProps = {
	scope: Scope;
	driving: boolean;
	onDrivingChange: (driving: boolean) => void;
	status: StreamStatus;
	onOpenUrl: (url: string) => void;
	onScreenshot: () => void;
	onTopChange: (onTop: boolean) => void;
};

/**
 * Open-URL popover, screenshot, always-on-top, a watch/drive toggle (drive scope only) and the
 * connection badge. A view-scope session gets no input controls at all.
 */
export function Toolbar({
	scope,
	driving,
	onDrivingChange,
	status,
	onOpenUrl,
	onScreenshot,
	onTopChange,
}: ToolbarProps) {
	const [url, setUrl] = useState("");
	const [open, setOpen] = useState(false);
	const badge = STATUS_BADGE[status];

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const value = url.trim();
		if (!value) return;
		onOpenUrl(value);
		setUrl("");
		setOpen(false);
	};

	return (
		<div
			className="flex shrink-0 items-center gap-1 border-b px-2"
			style={{ height: TOOLBAR_HEIGHT }}
			role="toolbar"
			aria-label="Viewer controls"
		>
			<Badge variant={badge.variant} size="sm">
				{badge.label}
			</Badge>
			<div className="flex-1" />
			{scope === "drive" && (
				<>
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open URL" title="Open URL" />}>
							<Link />
						</PopoverTrigger>
						<PopoverContent align="end">
							<form className="flex w-64 gap-2" onSubmit={submit}>
								<Input
									type="url"
									placeholder="https://"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									aria-label="URL"
									autoFocus
								/>
								<Button type="submit" size="sm">
									Open
								</Button>
							</form>
						</PopoverContent>
					</Popover>
					<Toggle
						size="sm"
						pressed={driving}
						onPressedChange={onDrivingChange}
						aria-label={driving ? "Driving. Switch to watch" : "Watching. Switch to drive"}
						title={driving ? "Driving" : "Watching"}
					>
						{driving ? <HandPointing /> : <Eye />}
					</Toggle>
				</>
			)}
			<Button variant="ghost" size="icon-sm" onClick={onScreenshot} aria-label="Screenshot" title="Screenshot">
				<Camera />
			</Button>
			<Toggle size="sm" onPressedChange={onTopChange} aria-label="Always on top" title="Always on top">
				<PushPin />
			</Toggle>
		</div>
	);
}
