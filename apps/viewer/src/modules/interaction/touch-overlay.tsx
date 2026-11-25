import type { Point } from "./geometry.ts";
import type { TouchOverlay } from "./touch-state.ts";

/**
 * Feedback for a single press, in container CSS px: a start disc, a pointer dot following the
 * pointer (smaller once dragging), and a connecting line while dragging. Purely visual, so it
 * ignores pointer events and is hidden from assistive tech. The disc is keyed by press id so a
 * new press mounts a fresh one instead of animating from the old.
 */
export function TouchFeedback({ touch }: { touch: TouchOverlay }) {
	if (!touch) return null;
	const releasing = touch.phase === "release";
	const dragging = touch.phase === "drag";
	const dotSize = dragging || releasing ? 18 : 34;
	const discOpacity = releasing ? 0 : dragging ? 0.34 : 1;

	return (
		<div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
			{dragging && (
				<svg className="absolute inset-0 size-full overflow-visible" aria-hidden>
					<line
						x1={touch.startX}
						y1={touch.startY}
						x2={touch.currentX}
						y2={touch.currentY}
						stroke="rgb(255 255 255 / 0.42)"
						strokeWidth={1.5}
						strokeLinecap="round"
					/>
				</svg>
			)}
			<div
				key={touch.id}
				className="touch-fx absolute rounded-full border border-white/70 bg-white/20 backdrop-blur-[1px]"
				style={{
					left: touch.startX - 17,
					top: touch.startY - 17,
					width: 34,
					height: 34,
					boxShadow: "0 0 18px rgb(255 255 255 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.16)",
					opacity: discOpacity,
					transform: releasing ? "scale(1.28)" : "scale(1)",
				}}
			/>
			<div
				className="touch-fx absolute rounded-full border border-white/80 bg-white/30 backdrop-blur-[1px]"
				style={{
					left: touch.currentX - dotSize / 2,
					top: touch.currentY - dotSize / 2,
					width: dotSize,
					height: dotSize,
					boxShadow: "0 0 12px rgb(255 255 255 / 0.24), 0 0 0 1px rgb(0 0 0 / 0.16)",
					opacity: releasing ? 0 : 1,
					transform: releasing ? "scale(0.72)" : "scale(1)",
				}}
			/>
		</div>
	);
}

export type Fingers = { first: Point; second: Point; pressed: boolean };

/** The two Alt-gesture finger discs and the line between them, in container CSS px. */
export function MultiTouchFeedback({ fingers }: { fingers: Fingers | null }) {
	if (!fingers) return null;
	const { first, second, pressed } = fingers;
	const disc = (point: Point) => (
		<div
			className="finger-fx absolute rounded-full border border-white/80 backdrop-blur-[1px]"
			style={{
				left: point.x - 16,
				top: point.y - 16,
				width: 32,
				height: 32,
				boxShadow: "0 0 14px rgb(255 255 255 / 0.24), 0 0 0 1px rgb(0 0 0 / 0.16)",
				background: pressed ? "rgb(255 255 255 / 0.3)" : "rgb(255 255 255 / 0.14)",
				transform: pressed ? "scale(0.82)" : "scale(1)",
			}}
		/>
	);
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
			<svg
				className="absolute inset-0 size-full overflow-visible"
				style={{ opacity: pressed ? 0.55 : 0.32 }}
				aria-hidden
			>
				<line
					x1={first.x}
					y1={first.y}
					x2={second.x}
					y2={second.y}
					stroke="rgb(255 255 255 / 0.36)"
					strokeWidth={1}
					strokeLinecap="round"
				/>
			</svg>
			{disc(first)}
			{disc(second)}
		</div>
	);
}
