import { IconCircleCheck, IconCircleInfo, IconExclamationCircle, IconExclamationTriangle } from "@/lib/icons/central";
import type { IconComponent } from "@/components/ui/icon";
import type { AlertStatus } from "./alert.variants";

/**
 * The glyph each status draws.
 *
 * `warning` and `destructive` differ in shape as well as colour — a triangle
 * against a circle — so the two stay distinguishable to anyone who cannot tell
 * amber from red. `default` shares `info`'s glyph: a neutral note is still a
 * note, and a status of its own would need a meaning it does not have.
 *
 * A leaf of its own rather than a constant in `alert-indicator.tsx`: `Toast`
 * draws the same glyph per status, so the two read as one family, and it may
 * import a leaf across folders where it may not import a part (package rule 3).
 * Not in `alert.variants.ts` because the glyphs are React Native SVG components,
 * and that file must stay free of React Native imports.
 */
export const ALERT_GLYPHS: Record<AlertStatus, IconComponent> = {
	default: IconCircleInfo,
	info: IconCircleInfo,
	success: IconCircleCheck,
	warning: IconExclamationTriangle,
	destructive: IconExclamationCircle,
};
