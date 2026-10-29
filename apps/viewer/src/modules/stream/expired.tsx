import { ClockCountdown } from "@phosphor-icons/react";

/** Shown in place of the stream once a detached session's token has expired. */
export function Expired() {
	return (
		<div className="flex h-svh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
			<ClockCountdown size={32} />
			<p className="text-sm font-medium">Access expired</p>
			<p className="text-xs text-muted-foreground">Run warden view again to reconnect.</p>
		</div>
	);
}
