import { Tooltip, TooltipContent, TooltipTrigger } from "@delacournz/apogee/tooltip";
import { orbCentre } from "./demo-device.ts";
import type { VideoSize } from "./use-whep.ts";

/**
 * Demo mode only: a hover target over the painted heartbeat orb (the canvas has no
 * DOM for it) explaining what it is. A name line, with a dot that pulses like the orb, then one
 * quieter line on how to read it. Placed in percentages of the screen box, which the
 * aspect-locked window keeps the same shape as the picture.
 */
export function DemoOrbHint({ size }: { size: VideoSize }) {
	const orb = orbCentre(size);
	const style = { left: `${(orb.x / size.width) * 100}%`, top: `${(orb.y / size.height) * 100}%` };
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						role="img"
						aria-label="Frame heartbeat: pulses while frames are drawing"
						className="absolute size-6 -translate-x-1/2 -translate-y-1/2 cursor-help rounded-full"
						style={style}
					/>
				}
			/>
			<TooltipContent side="bottom" align="end" sideOffset={6} className="max-w-64 text-left">
				<span className="flex flex-col gap-1 py-1">
					<span className="flex items-center gap-1.5 font-medium text-foreground">
						<span className="size-1.5 rounded-full bg-foreground motion-safe:animate-pulse" />
						Frame heartbeat
					</span>
					<span className="text-muted-foreground">Pulses while frames draw. If it stops, the picture has frozen.</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
