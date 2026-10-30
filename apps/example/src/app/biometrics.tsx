import { IconChevronLeft, IconFaceId, IconLock } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AttemptLog } from "@/modules/biometrics/components/attempt-log";
import { FaceGlyph } from "@/modules/biometrics/components/face-glyph";
import { VaultDrawer } from "@/modules/biometrics/components/vault-drawer";
import { useBiometricUnlock } from "@/modules/biometrics/hooks/use-biometric-unlock";
import { useVaultFonts } from "@/modules/biometrics/hooks/use-vault-fonts";
import { copyOf, VAULT } from "@/modules/biometrics/utils/vault-theme";

/**
 * Biometric unlock demo, styled as a dark vault for screen recordings: the face-frame glyph carries the state, the
 * readout under the headline shows the raw `status` / `error` the specs assert on (`bio-status`, `bio-error`), the
 * attempt log timestamps every try and the contents drawer rises on unlock. Reachable from Settings or
 * `warden-example://biometrics` (no sign-in gate). Every view a spec reads is `accessible` so its testID is in the
 * AX tree. The main button unlocks, or locks the vault again once it is open.
 */
export default function Biometrics() {
	const { status, error, events, unlock, lock } = useBiometricUnlock();
	const fonts = useVaultFonts();
	const insets = useSafeAreaInsets();

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const latestMatch = events.find((e) => e.kind === "unlocked");
	const copy = copyOf(status, latestMatch?.kind === "unlocked" ? latestMatch.tookMs : undefined);
	const isOpen = status === "Unlocked";
	const isBusy = status === "Scanning" || status === "Checking";
	const action = isOpen ? lock : unlock;
	const actionLabel = isOpen ? "Lock vault" : isBusy ? "Scanning…" : "Unlock with Face ID";

	return (
		<View style={[styles.screen, { paddingTop: insets.top }]} testID="bio-screen">
			<StatusBar style="light" />
			<View style={styles.navbar}>
				<Pressable
					accessibilityLabel="Back"
					accessibilityRole="button"
					accessible
					hitSlop={12}
					onPress={back}
					style={styles.back}
					testID="bio-back"
				>
					<IconChevronLeft color={VAULT.text} size={22} />
					<Text style={[styles.navTitle, { fontFamily: fonts.display }]}>Vault</Text>
				</Pressable>
				<IconLock color={isOpen ? VAULT.open : VAULT.faint} size={18} />
			</View>

			<ScrollView
				bounces={false}
				contentContainerStyle={styles.content}
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
			>
				<View style={styles.hero}>
					<FaceGlyph status={status} />
					<Text style={[styles.title, { fontFamily: fonts.displayBold }]}>{copy.title}</Text>
					<Text style={[styles.body, { fontFamily: fonts.body }]}>{copy.body}</Text>
				</View>

				<View style={styles.readout}>
					<View style={styles.readoutRow}>
						<Text style={[styles.key, { fontFamily: fonts.mono }]}>status</Text>
						<Text accessible style={[styles.val, { fontFamily: fonts.mono }]} testID="bio-status">
							{status}
						</Text>
					</View>
					<View style={styles.readoutRow}>
						<Text style={[styles.key, { fontFamily: fonts.mono }]}>error</Text>
						<Text accessible style={[styles.val, { fontFamily: fonts.mono }]} testID="bio-error">
							{error}
						</Text>
					</View>
				</View>

				{isOpen && <VaultDrawer display={fonts.display} mono={fonts.mono} />}

				<View style={styles.section}>
					<Text style={[styles.sectionTitle, { fontFamily: fonts.display }]}>Attempts</Text>
					<AttemptLog events={events} mono={fonts.mono} />
				</View>
			</ScrollView>

			<View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
				<Pressable
					accessibilityLabel={actionLabel}
					accessibilityRole="button"
					accessibilityState={{ disabled: isBusy }}
					accessible
					disabled={isBusy}
					onPress={action}
					style={({ pressed }) => [
						styles.button,
						isOpen && styles.buttonQuiet,
						isBusy && styles.buttonBusy,
						pressed && styles.buttonPressed,
					]}
					testID="bio-unlock"
				>
					{!isOpen && <IconFaceId color={isBusy ? VAULT.muted : VAULT.bg} size={20} />}
					<Text
						style={[
							styles.buttonLabel,
							{ fontFamily: fonts.display },
							isOpen && styles.buttonLabelQuiet,
							isBusy && styles.buttonLabelBusy,
						]}
					>
						{actionLabel}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: VAULT.bg },
	navbar: {
		height: 52,
		paddingHorizontal: 20,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	back: { flexDirection: "row", alignItems: "center", gap: 6 },
	navTitle: { color: VAULT.text, fontSize: 18, letterSpacing: 0.2 },
	content: { paddingHorizontal: 24, paddingBottom: 24, gap: 22 },
	hero: { alignItems: "center", paddingTop: 8 },
	title: { color: VAULT.text, fontSize: 34, letterSpacing: -0.6, marginTop: 4 },
	body: { color: VAULT.muted, fontSize: 16, lineHeight: 22, marginTop: 6, textAlign: "center", maxWidth: 300 },
	readout: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderColor: VAULT.line,
		paddingVertical: 12,
		gap: 8,
	},
	readoutRow: { flexDirection: "row", justifyContent: "space-between" },
	key: { color: VAULT.faint, fontSize: 13 },
	val: { color: VAULT.text, fontSize: 13 },
	section: { gap: 14 },
	sectionTitle: { color: VAULT.text, fontSize: 16 },
	footer: { paddingHorizontal: 24, paddingTop: 12, backgroundColor: VAULT.bg },
	button: {
		height: 56,
		borderRadius: 28,
		backgroundColor: VAULT.text,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
	},
	buttonQuiet: { backgroundColor: "transparent", borderWidth: 1, borderColor: VAULT.line },
	buttonBusy: { backgroundColor: VAULT.surface },
	buttonPressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },
	buttonLabel: { color: VAULT.bg, fontSize: 17, letterSpacing: 0.2 },
	buttonLabelQuiet: { color: VAULT.text },
	buttonLabelBusy: { color: VAULT.muted },
});
