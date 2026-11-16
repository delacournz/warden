import type { ActionVariant } from "@/modules/showcase/components/showcase";
import type { Tone } from "@/modules/showcase/utils/tones";
import type { PasskeyEvent } from "../hooks/use-passkey";
import { b64urlDecode } from "./webauthn";

/** What the screen shows; the strings are the values the specs assert on (`pk-status`). */
export const PASSKEY_STATUSES = [
	"Unsupported",
	"No passkey",
	"Creating",
	"Saved",
	"Signing in",
	"Signed in",
	"Cancelled",
	"Failed",
	"Rejected",
] as const;

export type PasskeyStatus = (typeof PASSKEY_STATUSES)[number];

/** `react-native-passkey` rejects with `{ error, message }`; `error` is its stable code (`UserCancelled`, `NoCredentials`, …). */
type LibraryError = { error: string; message: string };

function isLibraryError(value: unknown): value is LibraryError {
	return typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string";
}

/** The status and raw `error` code for a rejected create / get. */
export function failureOf(thrown: unknown): { status: "Cancelled" | "Failed"; error: string } {
	if (!isLibraryError(thrown)) return { status: "Failed", error: "unknown" };
	return { status: thrown.error === "UserCancelled" ? "Cancelled" : "Failed", error: thrown.error };
}

export type PasskeyAction =
	| { kind: "create"; label: "Create passkey"; variant: "solid" }
	| { kind: "sign-in"; label: "Sign in with passkey"; variant: "solid" }
	| { kind: "sign-out"; label: "Sign out"; variant: "outline" }
	| { kind: "wait"; label: string; variant: Extract<ActionVariant, "busy"> };

/** The one primary action: create while there is no passkey, then sign in, then sign out. */
export function actionOf(status: PasskeyStatus, hasPasskey: boolean): PasskeyAction {
	switch (status) {
		case "Unsupported":
			return { kind: "wait", label: "Passkeys unavailable", variant: "busy" };
		case "Creating":
			return { kind: "wait", label: "Creating…", variant: "busy" };
		case "Signing in":
			return { kind: "wait", label: "Signing in…", variant: "busy" };
		case "Signed in":
			return { kind: "sign-out", label: "Sign out", variant: "outline" };
		default:
			return hasPasskey
				? { kind: "sign-in", label: "Sign in with passkey", variant: "solid" }
				: { kind: "create", label: "Create passkey", variant: "solid" };
	}
}

/** The glyph's tone per state. */
export function toneOf(status: PasskeyStatus): Tone {
	switch (status) {
		case "Creating":
		case "Signing in":
			return "scan";
		case "Signed in":
			return "open";
		case "Cancelled":
		case "Failed":
		case "Rejected":
			return "warn";
		case "Unsupported":
			return "off";
		case "No passkey":
		case "Saved":
			return "idle";
	}
}

/** A measured duration as people read it: `27 ms` under a second (a virtual authenticator answers that fast), else `1.4 s`. */
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The hero headline and its one supporting line, per state. `error` is the raw code or failed check. */
export function copyOf(
	status: PasskeyStatus,
	at: { tookMs: number | undefined; error: string }
): { title: string; body: string } {
	switch (status) {
		case "Unsupported":
			return { title: "No passkeys here", body: "This device has no platform authenticator." };
		case "No passkey":
			return { title: "No passkey yet", body: "Create one for demo@warden.co.nz." };
		case "Creating":
			return { title: "Creating", body: "The authenticator is making a new key." };
		case "Saved":
			return {
				title: "Passkey saved",
				body: at.tookMs === undefined ? "Sign in with it." : `Saved in ${seconds(at.tookMs)}. Sign in with it.`,
			};
		case "Signing in":
			return { title: "Signing in", body: "The passkey is signing the challenge." };
		case "Signed in":
			return {
				title: "Signed in",
				body: at.tookMs === undefined ? "Signature verified." : `Signature verified in ${seconds(at.tookMs)}.`,
			};
		case "Cancelled":
			return { title: "Cancelled", body: "The passkey sheet was dismissed." };
		case "Failed":
			return { title: "Passkey failed", body: `The platform answered ${at.error}.` };
		case "Rejected":
			return { title: "Rejected", body: `The response failed the ${at.error} check.` };
	}
}

/**
 * The measured time the hero line quotes: `Saved` quotes the create, `Signed in` the latest sign-in. Each reads its
 * own event, so after a sign-out the create's time is not replaced by the sign-in's. Newest-first `events`.
 */
export function tookMsOf(status: PasskeyStatus, events: readonly PasskeyEvent[]): number | undefined {
	for (const event of events) {
		if (status === "Saved" && event.kind === "saved") return event.tookMs;
		if (status === "Signed in" && event.kind === "signed-in") return event.tookMs;
	}
	return undefined;
}

/** The readout's credential row: the first 8 base64url characters, or `none`. */
export function shortId(credentialId: string | undefined): string {
	return credentialId === undefined ? "none" : credentialId.slice(0, 8);
}

/** Number of cuts along the glyph's key blade. */
export const CUTS = 6;

/**
 * The glyph key's cut depths (1-4), one per cut, read from the credential id's first bytes, so every passkey cuts a
 * different key and the shape on screen is the real credential's. No credential (or an unreadable one) is the uncut
 * blank: all zeros.
 */
export function bittingOf(credentialId: string | undefined): number[] {
	const blank = Array.from({ length: CUTS }, () => 0);
	if (credentialId === undefined) return blank;
	let bytes: Uint8Array;
	try {
		bytes = b64urlDecode(credentialId);
	} catch {
		return blank;
	}
	if (bytes.length < CUTS) return blank;
	return Array.from(bytes.slice(0, CUTS), (b) => 1 + (b % 4));
}
