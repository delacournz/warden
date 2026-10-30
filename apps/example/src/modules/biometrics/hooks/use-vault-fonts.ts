import {
	ChakraPetch_400Regular,
	ChakraPetch_600SemiBold,
	ChakraPetch_700Bold,
	useFonts,
} from "@expo-google-fonts/chakra-petch";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { useCSSVariable } from "uniwind";

/** The vault's font styles; every `fontFamily` is `undefined` until the faces load, so text falls back to the system face. */
export type VaultFonts = {
	display: { fontFamily: string | undefined };
	displayBold: { fontFamily: string | undefined };
	body: { fontFamily: string | undefined };
	readout: { fontFamily: string | undefined };
};

/**
 * Loads the vault's two faces (Chakra Petch for the display voice, JetBrains Mono for readouts) from the JS bundle,
 * so no native rebuild is needed, and returns them as `style` objects whose family names come from the theme's font
 * tokens (`--font-display`, `--font-display-bold`, `--font-body`, `--font-readout` in `styles/app.css`).
 *
 * A `style` and not a `font-*` class on purpose: a class resolves a frame after the text is laid out, so native text
 * measured in the system face is drawn in the vault face and clips its last glyph. Colour, spacing and size stay
 * classes. The screen renders at once in the system face and its testIDs never wait on a font.
 */
export function useVaultFonts(): VaultFonts {
	const [loaded] = useFonts({
		ChakraPetch_400Regular,
		ChakraPetch_600SemiBold,
		ChakraPetch_700Bold,
		JetBrainsMono_500Medium,
	});
	const [display, displayBold, body, readout] = useCSSVariable([
		"--font-display",
		"--font-display-bold",
		"--font-body",
		"--font-readout",
	]) as (string | undefined)[];
	const family = (name: string | undefined) => ({ fontFamily: loaded ? name : undefined });
	return {
		display: family(display),
		displayBold: family(displayBold),
		body: family(body),
		readout: family(readout),
	};
}
