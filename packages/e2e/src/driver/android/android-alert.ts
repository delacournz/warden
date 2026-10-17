import type { AlertInfo, Element } from "../driver.types";

export { ANDROID_ALLOW_IDS, ANDROID_DENY_IDS } from "../../alert-buttons";

/**
 * System alerts on Android are ordinary windows in the dump. `AlertDialog` uses `android:id/button1|2|3`
 * (positive / negative / neutral), the runtime-permission dialog (permissioncontroller) its own
 * `permission_*_button` ids, and the system "isn't responding" dialog `aerr_close` / `aerr_wait` (read off a real
 * ANR dialog, `anr.fixture.ts`). The identifier is the resource id without its `pkg:id/` prefix.
 */

const ALERT_BUTTON_IDS: ReadonlySet<string> = new Set([
	"button1",
	"button2",
	"button3",
	"permission_allow_button",
	"permission_allow_foreground_only_button",
	"permission_allow_one_time_button",
	"permission_deny_button",
	"permission_deny_and_dont_ask_again_button",
	"permission_no_upgrade_button",
	"aerr_close",
	"aerr_wait",
]);

function textOf(element: Element | undefined): string | undefined {
	return element?.text || element?.label || undefined;
}

const byIdentifier = (flat: readonly Element[], id: string): Element | undefined =>
	flat.find((e) => e.identifier === id);

/** The alert on screen, or null. Title/message are best effort; at least one known button is required. */
export function detectAlert(flat: readonly Element[]): AlertInfo | null {
	const buttons = flat.filter((e) => e.identifier !== undefined && ALERT_BUTTON_IDS.has(e.identifier));
	if (buttons.length === 0) return null;
	const title = textOf(byIdentifier(flat, "alertTitle")) ?? textOf(byIdentifier(flat, "permission_message"));
	const message = textOf(byIdentifier(flat, "message"));
	return { ...(title ? { title } : {}), ...(message ? { message } : {}), buttons };
}
