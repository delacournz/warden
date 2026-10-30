import type { BiometricStatus } from "../hooks/use-biometric-unlock";

/**
 * The vault's own dark world: a cool graphite night, one blue for "looking", green for "open", amber for "still
 * locked". Text colours clear 4.5:1 on `bg` (muted is 6.6:1, faint 4.6:1).
 */
export const VAULT = {
	bg: "#07090D",
	surface: "#0E1219",
	line: "#1B2230",
	text: "#E9EDF4",
	muted: "#8C96A9",
	faint: "#6F7A8E",
	idle: "#C8D3F5",
	scan: "#5B8CFF",
	open: "#3DDC97",
	warn: "#FFB547",
	off: "#55607A",
} as const;

/** Font family names registered by `useVaultFonts`; undefined until they load, so text falls back to the system. */
export const VAULT_FONTS = {
	display: "ChakraPetch_600SemiBold",
	displayBold: "ChakraPetch_700Bold",
	body: "ChakraPetch_400Regular",
	mono: "JetBrainsMono_500Medium",
} as const;

/** The glyph's tint per state. */
export function tintOf(status: BiometricStatus): string {
	switch (status) {
		case "Scanning":
			return VAULT.scan;
		case "Unlocked":
			return VAULT.open;
		case "Failed":
		case "Cancelled":
			return VAULT.warn;
		case "Not enrolled":
		case "Checking":
			return VAULT.off;
		case "Ready":
			return VAULT.idle;
	}
}

/** The hero headline and its one supporting line, per state. */
export function copyOf(status: BiometricStatus, tookMs: number | undefined): { title: string; body: string } {
	switch (status) {
		case "Checking":
			return { title: "Checking sensors", body: "Reading Face ID enrollment." };
		case "Not enrolled":
			return { title: "No face enrolled", body: "Enroll Face ID on this device to open the vault." };
		case "Ready":
			return { title: "Vault locked", body: "Face ID is enrolled. Look to open it." };
		case "Scanning":
			return { title: "Scanning", body: "Hold still while Face ID looks for you." };
		case "Unlocked":
			return {
				title: "Vault open",
				body: tookMs === undefined ? "Face matched." : `Face matched in ${(tookMs / 1000).toFixed(1)} s.`,
			};
		case "Failed":
			return { title: "Still locked", body: "That face did not match." };
		case "Cancelled":
			return { title: "Still locked", body: "The Face ID prompt was cancelled." };
	}
}
