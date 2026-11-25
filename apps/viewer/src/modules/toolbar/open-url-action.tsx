import { Button } from "@delacournz/apogee/button";
import { Input } from "@delacournz/apogee/input";
import { Popover, PopoverContent, PopoverTrigger } from "@delacournz/apogee/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@delacournz/apogee/tooltip";
import { Link } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { normalizeUrl } from "./url.ts";

type OpenUrlActionProps = {
	onOpenUrl: (url: string) => void;
	disabledReason: string | null;
};

/** The open-URL button and its popover. Disabled, it is a plain disabled icon button with the reason. */
export function OpenUrlAction({ onOpenUrl, disabledReason }: OpenUrlActionProps) {
	const [url, setUrl] = useState("");
	const [open, setOpen] = useState(false);
	const target = normalizeUrl(url);

	if (disabledReason) {
		return (
			<IconButton label="Open URL on device" onClick={() => undefined} disabledReason={disabledReason}>
				<Link />
			</IconButton>
		);
	}

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!target) return;
		onOpenUrl(target);
		setUrl("");
		setOpen(false);
	};

	return (
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
	);
}
