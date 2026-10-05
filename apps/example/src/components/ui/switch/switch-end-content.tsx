import type { ReactElement } from "react";
import type { SwitchContentProps } from "./switch.types";
import { SwitchContent } from "./switch-content";

/**
 * Content at the trailing edge of the track, behind the thumb.
 *
 * Revealed as the switch turns **off** — this is the end the knob vacates — so
 * it is where the "off" mark goes: a cross, a moon, the word OFF. The fade is
 * the component's, so write it once and unconditionally.
 *
 * It sits on the resting track rather than the coloured one, so its glyph takes
 * a muted foreground rather than the switch's colour.
 */
export function SwitchEndContent(props: SwitchContentProps): ReactElement {
	return <SwitchContent part="Switch.EndContent" placement="end" {...props} />;
}
SwitchEndContent.displayName = "DelacourUI.Switch.EndContent";
