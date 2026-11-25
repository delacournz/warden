import { Button } from "@delacournz/apogee/button";
import { Coins, Power } from "@phosphor-icons/react";
import type { Overlay } from "./billing-state.ts";

type StoppedStateProps = {
	overlay: Extract<Overlay, "out-of-credits" | "stopped">;
	hasBillingUrl: boolean;
	onTopUp: () => void;
};

/**
 * Replaces the stream once the device is stopped. Out of credits offers Top up, which opens the
 * launch-time billing URL from Rust; without one it names the page to visit instead. Any other
 * stop is a calm "Device stopped". Unlike the stream overlays this one takes clicks.
 */
export function StoppedState({ overlay, hasBillingUrl, onTopUp }: StoppedStateProps) {
	if (overlay === "stopped") {
		return (
			<div
				role="status"
				aria-live="polite"
				className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 px-8 text-center backdrop-blur-sm"
			>
				<div className="text-muted-foreground">
					<Power size={22} />
				</div>
				<p className="text-sm font-medium text-foreground">Device stopped</p>
				<p className="max-w-56 text-xs text-muted-foreground">Run warden again to start a new one.</p>
			</div>
		);
	}
	return (
		<div
			role="alert"
			className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 px-8 text-center backdrop-blur-sm"
		>
			<div className="text-muted-foreground">
				<Coins size={22} />
			</div>
			<p className="text-sm font-medium text-foreground">You've run out of credits</p>
			<p className="max-w-56 text-xs text-muted-foreground">The device was stopped. Top up to start a new one.</p>
			{hasBillingUrl ? (
				<Button size="sm" onClick={onTopUp}>
					Top up
				</Button>
			) : (
				<p className="text-xs text-foreground">Top up at app.warden.co.nz/billing</p>
			)}
		</div>
	);
}
