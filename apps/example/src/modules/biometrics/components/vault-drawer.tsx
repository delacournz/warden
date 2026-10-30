import { Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInUp, FadeOutDown } from "react-native-reanimated";

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
export function VaultDrawer() {
	return (
		<Animated.View
			className="rounded-2xl border border-success/35 bg-card px-[18px] py-3.5"
			entering={FadeInUp.duration(520).easing(Easing.out(Easing.exp))}
			exiting={FadeOutDown.duration(200)}
		>
			<View className="flex-row items-baseline justify-between pb-1.5">
				<Text className="font-display text-base text-foreground">Contents</Text>
				<Text className="font-readout text-[11px] text-tertiary-foreground">demo values</Text>
			</View>
			{SECRETS.map((secret, i) => (
				<View className={i > 0 ? "gap-1 border-t border-border py-2.5" : "gap-1 py-2.5"} key={secret.label}>
					<Text className="font-display text-[13px] text-muted-foreground">{secret.label}</Text>
					<Animated.Text
						className="font-readout text-[15px] text-success"
						entering={FadeIn.delay(260 + i * 140).duration(360)}
						numberOfLines={1}
					>
						{secret.value}
					</Animated.Text>
				</View>
			))}
		</Animated.View>
	);
}
