import { Spinner } from "@delacournz/apogee/spinner";
import { ClockCountdown, WifiSlash } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { StreamStatus } from "./whep-session.ts";

type Copy = { icon: ReactNode; title: string; hint: string };

function copyFor(status: StreamStatus, unreachable: boolean): Copy | null {
	if (status === "streaming" || status === "stopped") return null;
	if (status === "expired") {
		return {
			icon: <ClockCountdown size={22} />,
			title: "Access expired",
			hint: "Run warden view again to reconnect.",
		};
	}
	if (unreachable) {
		return {
			icon: <WifiSlash size={22} />,
			title: "Can't reach warden cloud",
			hint: "Retrying automatically. Check your connection.",
		};
	}
	if (status === "reconnecting") {
		return { icon: <Spinner />, title: "Reconnecting", hint: "The stream dropped. Retrying automatically." };
	}
	return { icon: <Spinner />, title: "Connecting", hint: "Waiting for the first frame." };
}

/**
 * A calm centred overlay for every non-streaming state: connecting, reconnecting, unreachable and
 * expired. It never blocks the window controls, and an expired session shows no spinner.
 */
export function StreamState({ status, unreachable }: { status: StreamStatus; unreachable: boolean }) {
	const copy = copyFor(status, unreachable);
	if (!copy) return null;
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 px-8 text-center backdrop-blur-sm"
		>
			<div className="text-muted-foreground">{copy.icon}</div>
			<p className="text-sm font-medium text-foreground">{copy.title}</p>
			<p className="max-w-56 text-xs text-muted-foreground">{copy.hint}</p>
		</div>
	);
}
