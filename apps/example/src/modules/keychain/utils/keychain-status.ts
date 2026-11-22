/** What the Keychain screen shows; the strings are the values the specs assert on. */
export type KeychainStatus =
	| "Ready"
	| "Saved"
	| "Reading"
	| "Read"
	| "Cancelled"
	| "Needs UI"
	| "Invalidated"
	| "Failed"
	| "Deleted"
	| "Unavailable";

/**
 * The OSStatus of a data read as a status: `-128` errSecUserCanceled, `-25308` errSecInteractionNotAllowed (no UI
 * allowed), `-25300` errSecItemNotFound (what a biometry-only item answers once its enrolment is gone).
 */
export function readStatusOf(code: number): KeychainStatus {
	if (code === 0) return "Read";
	if (code === -128) return "Cancelled";
	if (code === -25308) return "Needs UI";
	if (code === -25300) return "Invalidated";
	return "Failed";
}

/** The OSStatus of a write as a status. */
export function saveStatusOf(code: number): KeychainStatus {
	return code === 0 ? "Saved" : "Failed";
}
