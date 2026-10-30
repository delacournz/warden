import { useMemo } from "react";
import { useCSSVariable } from "uniwind";
import { TONE_VARIABLE, type VaultTone } from "../utils/vault-theme";

/** A tone resolved to a colour string for props that cannot take a className: SVG strokes, gradient stops, Reanimated. */
export type VaultTones = Record<VaultTone, string>;

/** What a tone reads as when its variable is missing: transparent, so a miss shows up on screen instead of lying. */
const MISSING = "transparent";

/**
 * The vault's tones as plain colour strings, read from the active theme (`styles/app.css`). Follows light / dark.
 * The result keeps its identity until a colour actually changes, so it is safe in an effect's dependencies.
 */
export function useVaultTones(): VaultTones {
	const [idle, scan, open, warn, off] = useCSSVariable([
		TONE_VARIABLE.idle,
		TONE_VARIABLE.scan,
		TONE_VARIABLE.open,
		TONE_VARIABLE.warn,
		TONE_VARIABLE.off,
	]) as (string | undefined)[];
	return useMemo(
		() => ({
			idle: idle ?? MISSING,
			scan: scan ?? MISSING,
			open: open ?? MISSING,
			warn: warn ?? MISSING,
			off: off ?? MISSING,
		}),
		[idle, scan, open, warn, off]
	);
}
