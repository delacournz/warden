import { Button } from "@delacournz/apogee/button";
import { Power } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

type ClosePromptProps = {
	busy: boolean;
	onKeep: () => void;
	onShutDown: () => void;
	onCancel: () => void;
};

/**
 * Asked when the window closes on a live device: keep the hosted device and its lease (the lease TTL then
 * applies and `warden view` reopens it), or shut it down and release the lease. Escape cancels, and focus
 * starts on Keep running so a stray Enter never stops a device.
 */
export function ClosePrompt({ busy, onKeep, onShutDown, onCancel }: ClosePromptProps) {
	const keepRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		keepRef.current?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);

	return (
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="close-prompt-title"
			aria-describedby="close-prompt-body"
			className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/85 px-6 text-center backdrop-blur-sm"
		>
			<div className="text-muted-foreground">
				<Power size={22} />
			</div>
			<p id="close-prompt-title" className="text-sm font-medium text-foreground">
				Close the viewer?
			</p>
			<p id="close-prompt-body" className="max-w-60 text-xs text-muted-foreground">
				Keep the device running to reopen it with warden view, or shut it down and release the lease.
			</p>
			<div className="mt-2 flex w-full max-w-52 flex-col gap-1.5">
				<Button ref={keepRef} size="sm" variant="outline" disabled={busy} onClick={onKeep}>
					Keep running
				</Button>
				<Button size="sm" variant="destructive" disabled={busy} onClick={onShutDown}>
					Shut down device
				</Button>
				<Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
