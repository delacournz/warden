import type { ComponentStat } from "./reduce";

const ANIMATED = [
	"Animated",
	"Reanimated",
	"Animation",
	"Lottie",
	"Spinner",
	"ActivityIndicator",
	"Shimmer",
	"Skeleton",
	"Ticker",
	"Marquee",
	"Pulse",
];
const TRANSITION = ["Transition", "Screen", "Navigator", "Stack", "Drawer", "Modal", "Sheet", "Backdrop"];

function hits(name: string, words: readonly string[]): boolean {
	return words.some((w) => name.includes(w));
}

/**
 * Tag components that render a lot by design: animations tick every frame, transitions render while a screen
 * slides. They are kept in the stats but not reported as problems on their own.
 */
export function tagComponents(stats: ComponentStat[]): ComponentStat[] {
	return stats.map((s) => {
		if (hits(s.name, ANIMATED)) return { ...s, tag: "animated" as const };
		if (hits(s.name, TRANSITION)) return { ...s, tag: "transition" as const };
		return s;
	});
}
