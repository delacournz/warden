import type { ReactElement } from "react";
import type { SwitchContentProps } from "./switch.types";
import { SwitchContent } from "./switch-content";

/**
 * Content at the leading edge of the track, behind the thumb.
 *
 * Revealed as the switch turns **on** — this is the end the knob vacates — so it
 * is where the "on" mark goes: a tick, a sun, the word ON. The fade is the
 * component's, so write it once and unconditionally; there is no `isSelected &&`
 * to remember.
 *
 * An `Icon` needs nothing said at the call site: it inherits the switch's glyph
 * step and the foreground of the colour the track fades to. A bare string is
 * wrapped in a `Text` that inherits the same treatment.
 */
export function SwitchStartContent(props: SwitchContentProps): ReactElement {
	return <SwitchContent part="Switch.StartContent" placement="start" {...props} />;
}
SwitchStartContent.displayName = "DelacourUI.Switch.StartContent";
