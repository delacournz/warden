import { StyleSheet, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInUp, FadeOutDown } from "react-native-reanimated";
import { VAULT } from "../utils/vault-theme";

/**
 * Illustrative secrets for the demo; none of them is a real credential. Even so they are shown masked, the way a
 * real vault reveals one: enough to recognise the item, never the whole value on screen.
 */
const SECRETS = [
	{ label: "Release signing key", value: "wdn_sk_••••••••c2e0" },
	{ label: "App Store Connect", value: "ASC-••••-QZ7M" },
] as const;

/**
 * What the vault holds, revealed when it opens: the drawer rises once and each value fades in after its label, top
 * to bottom. Unmounts (sinking out) as soon as the vault locks again.
 */
export function VaultDrawer({ display, mono }: { display: string | undefined; mono: string | undefined }) {
	return (
		<Animated.View
			entering={FadeInUp.duration(520).easing(Easing.out(Easing.exp))}
			exiting={FadeOutDown.duration(200)}
			style={styles.drawer}
		>
			<View style={styles.head}>
				<Text style={[styles.title, { fontFamily: display }]}>Contents</Text>
				<Text style={[styles.note, { fontFamily: mono }]}>demo values</Text>
			</View>
			{SECRETS.map((secret, i) => (
				<View key={secret.label} style={[styles.row, i > 0 && styles.divider]}>
					<Text style={[styles.label, { fontFamily: display }]}>{secret.label}</Text>
					<Animated.Text
						entering={FadeIn.delay(260 + i * 140).duration(360)}
						numberOfLines={1}
						style={[styles.value, { fontFamily: mono }]}
					>
						{secret.value}
					</Animated.Text>
				</View>
			))}
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	drawer: {
		backgroundColor: VAULT.surface,
		borderRadius: 16,
		paddingHorizontal: 18,
		paddingVertical: 14,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(61,220,151,0.35)",
	},
	head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 6 },
	title: { color: VAULT.text, fontSize: 16 },
	note: { color: VAULT.faint, fontSize: 11 },
	row: { paddingVertical: 10, gap: 4 },
	divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: VAULT.line },
	label: { color: VAULT.muted, fontSize: 13 },
	value: { color: VAULT.open, fontSize: 15 },
});
