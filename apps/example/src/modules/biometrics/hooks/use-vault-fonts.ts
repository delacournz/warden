import {
	ChakraPetch_400Regular,
	ChakraPetch_600SemiBold,
	ChakraPetch_700Bold,
	useFonts,
} from "@expo-google-fonts/chakra-petch";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";

/**
 * Loads the vault's two faces (Chakra Petch for the display voice, JetBrains Mono for readouts) from the JS bundle,
 * so no native rebuild is needed. The family names are the theme's font tokens (`font-display`, `font-display-bold`,
 * `font-body`, `font-readout` in `styles/app.css`), so nothing else here is read: until a face loads the system face
 * draws, and the screen's testIDs never wait on a font.
 */
export function useVaultFonts(): void {
	useFonts({
		ChakraPetch_400Regular,
		ChakraPetch_600SemiBold,
		ChakraPetch_700Bold,
		JetBrainsMono_500Medium,
	});
}
