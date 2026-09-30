import type { ReactElement } from "react";
import { cn } from "@/lib/cn";

/**
 * A device's lifecycle as warden reports it. `empty` is a pool slot warden has
 * not created yet. Every phase has a label and a distinct glyph shape; only
 * `leased` carries colour.
 */
export type Phase = "empty" | "shutdown" | "booting" | "booted" | "leased";

export const PHASE_LABEL: Record<Phase, string> = {
	empty: "not created",
	shutdown: "shutdown",
	booting: "booting",
	booted: "booted · free",
	leased: "leased",
};

/** The phase glyph: hollow ring, spinning arc, gray dot, lamp. Shape carries the state, colour only confirms it. */
export function PhaseGlyph({ phase, className }: { phase: Phase; className?: string }): ReactElement {
	switch (phase) {
		case "empty":
			return (
				<svg aria-hidden="true" className={cn("size-2.5", className)} viewBox="0 0 10 10">
					<circle cx="5" cy="5" fill="none" r="4" stroke="currentColor" strokeDasharray="2 1.6" strokeWidth="1.2" />
				</svg>
			);
		case "shutdown":
			return (
				<svg aria-hidden="true" className={cn("size-2.5", className)} viewBox="0 0 10 10">
					<circle cx="5" cy="5" fill="none" r="4" stroke="currentColor" strokeWidth="1.4" />
				</svg>
			);
		case "booting":
			return (
				<svg aria-hidden="true" className={cn("size-2.5 animate-spin", className)} viewBox="0 0 10 10">
					<circle cx="5" cy="5" fill="none" opacity="0.3" r="4" stroke="currentColor" strokeWidth="1.4" />
					<path d="M5 1a4 4 0 0 1 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
				</svg>
			);
		case "booted":
			return (
				<svg aria-hidden="true" className={cn("size-2.5", className)} viewBox="0 0 10 10">
					<circle cx="5" cy="5" fill="currentColor" r="4" />
				</svg>
			);
		case "leased":
			return (
				<svg aria-hidden="true" className={cn("size-2.5 text-lamp", className)} viewBox="0 0 10 10">
					<circle cx="5" cy="5" fill="currentColor" r="4.5" />
				</svg>
			);
	}
}

/**
 * A phone, drawn as geometry: body, screen, island. The screen shows the phase —
 * off, a boot progress bar, or a quiet home grid — and a leased device lights
 * its lamp in the status bar. `progress` (0–1) drives the boot bar.
 */
export function DeviceFrame({
	phase,
	progress = 0,
	className,
}: {
	phase: Phase;
	progress?: number;
	className?: string;
}): ReactElement {
	if (phase === "empty") {
		return (
			<svg aria-hidden="true" className={cn("text-hairline", className)} viewBox="0 0 120 250">
				<rect
					fill="none"
					height="244"
					rx="22"
					stroke="currentColor"
					strokeDasharray="5 5"
					strokeWidth="2"
					width="114"
					x="3"
					y="3"
				/>
			</svg>
		);
	}

	const on = phase === "booted" || phase === "leased";

	return (
		<svg aria-hidden="true" className={className} viewBox="0 0 120 250">
			<rect
				className="fill-[#1c1c1e] stroke-[#48484a]"
				height="247"
				rx="24"
				strokeWidth="1.5"
				width="117"
				x="1.5"
				y="1.5"
			/>
			<rect
				className={cn("transition-[fill] duration-700", on ? "fill-[#f2f2f7] dark:fill-[#2c2c2e]" : "fill-[#0b0b0c]")}
				height="232"
				rx="17"
				width="102"
				x="9"
				y="9"
			/>
			<rect fill="#0b0b0c" height="9" rx="4.5" width="34" x="43" y="16" />
			{phase === "booting" ? (
				<g>
					<rect fill="#3a3a3c" height="3" rx="1.5" width="44" x="38" y="140" />
					<rect fill="#f5f5f7" height="3" rx="1.5" width={Math.max(3, 44 * progress)} x="38" y="140" />
				</g>
			) : null}
			{on ? (
				<g className="fill-[#dcdce1] dark:fill-[#3a3a3c]">
					{[0, 1, 2, 3, 4].map((row) =>
						[0, 1, 2, 3].map((col) => (
							<rect height="15" key={`${row}-${col}`} rx="4.5" width="15" x={21 + col * 21} y={44 + row * 26} />
						))
					)}
					<rect height="22" rx="9" width="84" x="18" y="206" />
				</g>
			) : null}
			{phase === "leased" ? <circle className="fill-lamp" cx="95" cy="20.5" r="4" /> : null}
		</svg>
	);
}
