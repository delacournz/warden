import type { PasskeyCredential, PasskeyMode } from "@delacour/warden-core/conditions/conditions.types";
import type { Element } from "../driver.types";

/**
 * The Credential Manager's own UI, as the accessibility tree shows it. It is Compose with no resource ids, so it is
 * recognised by its English texts and content descriptions (read off an API 37 Play image, `docs/plans/wdn-pass-0-android-findings.md`):
 *
 *   create   "Create passkey to sign in to <app>?" + `Save another way` + `Continue` (always shown, one tap)
 *   choose   "Choose a saved passkey for <app>" + one button per stored passkey (shown for 2+ matching passkeys)
 *   empty    GMS's chooser when warden's provider offers nothing: "Sign in another way" (get) with a `Dismiss` group,
 *            or "Create passkey on another device?" (create) with a `Close sheet` scrim
 *
 * `sheetAction` says what warden does with it per mode, so a spec never sees it. A sheet it does not recognise (other
 * locale, newer Play services) is left alone: the spec then sees it and can drive it.
 */

export type PasskeySheet =
	| { kind: "create"; proceed: Element; close: Element | undefined }
	| { kind: "choose"; close: Element | undefined }
	| { kind: "empty"; dismiss: Element };

const textOf = (e: Element): string => e.text ?? e.label ?? "";

const withText = (flat: readonly Element[], text: string): Element | undefined => flat.find((e) => textOf(e) === text);

const withLabel = (flat: readonly Element[], label: string): Element | undefined => flat.find((e) => e.label === label);

const startsWith = (flat: readonly Element[], prefix: string): Element | undefined =>
	flat.find((e) => textOf(e).startsWith(prefix));

/** The passkey sheet on screen, or null. */
export function detectPasskeySheet(flat: readonly Element[]): PasskeySheet | null {
	const close = withLabel(flat, "Close");
	const proceed = withText(flat, "Continue");
	if (proceed !== undefined && withText(flat, "Save another way") !== undefined) {
		return { kind: "create", proceed, close };
	}
	if (startsWith(flat, "Choose a saved passkey") !== undefined) return { kind: "choose", close };
	const dismiss = withLabel(flat, "Dismiss") ?? withLabel(flat, "Close sheet");
	const gms = withText(flat, "Sign in another way") ?? startsWith(flat, "Create passkey on another device");
	if (dismiss !== undefined && gms !== undefined) return { kind: "empty", dismiss };
	return null;
}

/** What warden does to a sheet: tap an element, or leave it. */
export type SheetAction = { do: "tap"; element: Element; why: string } | { do: "leave"; why: string };

/**
 * Per mode (`auto` / `cancel` / `fail`: select the passkey, the provider then answers per mode, so the app sees the
 * exact exception; `unavailable`: close, the app sees a cancellation; `off` or no provider: not ours, leave it).
 * `choose` taps the newest stored passkey (the one an assertion without `allowCredentials` would pick).
 */
export function sheetAction(
	sheet: PasskeySheet,
	flat: readonly Element[],
	mode: PasskeyMode | "off",
	credentials: readonly PasskeyCredential[]
): SheetAction {
	if (mode === "off") return { do: "leave", why: "the virtual authenticator is off" };
	if (sheet.kind === "empty")
		return { do: "tap", element: sheet.dismiss, why: "no passkey to offer: dismiss the chooser" };
	if (mode === "unavailable") {
		return sheet.close
			? { do: "tap", element: sheet.close, why: "unavailable: close the sheet" }
			: { do: "leave", why: "no close control" };
	}
	if (sheet.kind === "create") return { do: "tap", element: sheet.proceed, why: "continue to create the passkey" };
	const newest = [...credentials].sort((a, b) => b.createdAt - a.createdAt);
	for (const credential of newest) {
		const entry = flat.find((e) => textOf(e) === credential.userName);
		if (entry !== undefined) return { do: "tap", element: entry, why: `choose ${credential.userName}` };
	}
	return { do: "leave", why: "no stored passkey is listed on the sheet" };
}
