import {
	ChakraPetch_400Regular,
	ChakraPetch_600SemiBold,
	ChakraPetch_700Bold,
	useFonts,
} from "@expo-google-fonts/chakra-petch";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { VAULT_FONTS } from "../utils/vault-theme";

type VaultFontFamilies = { [K in keyof typeof VAULT_FONTS]: string | undefined };

/**
 * Loads the vault's two faces (Chakra Petch for the display voice, JetBrains Mono for readouts) from the JS bundle,
 * so no native rebuild is needed. Families stay `undefined` until loaded: the screen renders at once in the system
 * face, and its testIDs never wait on a font.
 */
export function useVaultFonts(): VaultFontFamilies {
	const [loaded] = useFonts({
		[VAULT_FONTS.body]: ChakraPetch_400Regular,
		[VAULT_FONTS.display]: ChakraPetch_600SemiBold,
		[VAULT_FONTS.displayBold]: ChakraPetch_700Bold,
		[VAULT_FONTS.mono]: JetBrainsMono_500Medium,
	});
	return {
		display: loaded ? VAULT_FONTS.display : undefined,
		displayBold: loaded ? VAULT_FONTS.displayBold : undefined,
		body: loaded ? VAULT_FONTS.body : undefined,
		mono: loaded ? VAULT_FONTS.mono : undefined,
	};
}
