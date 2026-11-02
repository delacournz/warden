export type Ripple = { id: number; x: number; y: number };

/** Small expanding rings where the user pressed. Each removes itself when its animation ends. */
export function TapRipples({ ripples, onDone }: { ripples: Ripple[]; onDone: (id: number) => void }) {
	return (
		<>
			{ripples.map((r) => (
				<span
					key={r.id}
					aria-hidden
					className="tap-ripple pointer-events-none absolute size-8 rounded-full border border-foreground/60 bg-foreground/15"
					style={{ left: r.x, top: r.y }}
					onAnimationEnd={() => onDone(r.id)}
				/>
			))}
		</>
	);
}
