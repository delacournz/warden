import type { Tone } from "@/modules/showcase/utils/tones";
import type { BiometricStatus } from "../hooks/use-biometric-unlock";

/** The glyph's tone per state. */
export function toneOf(status: BiometricStatus): Tone {
	switch (status) {
		case "Scanning":
			return "scan";
		case "Unlocked":
			return "open";
		case "Failed":
		case "Cancelled":
			return "warn";
		case "Not enrolled":
		case "Checking":
			return "off";
		case "Ready":
			return "idle";
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
