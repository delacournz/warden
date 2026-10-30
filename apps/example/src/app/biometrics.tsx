import { IconChevronLeft, IconFaceId, IconLock } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { AttemptLog } from "@/modules/biometrics/components/attempt-log";
import { FaceGlyph } from "@/modules/biometrics/components/face-glyph";
import { VaultDrawer } from "@/modules/biometrics/components/vault-drawer";
import { useBiometricUnlock } from "@/modules/biometrics/hooks/use-biometric-unlock";
import { copyOf } from "@/modules/biometrics/utils/vault-theme";

/** The main button's fill and label classes: solid when it unlocks, outlined when it locks, dim while scanning. */
function actionClasses(isOpen: boolean, isBusy: boolean): { button: string; label: string } {
	if (isOpen) return { button: "border border-border bg-transparent", label: "text-foreground" };
	if (isBusy) return { button: "bg-card", label: "text-muted-foreground" };
	return { button: "bg-foreground", label: "text-background" };
}

/**
 * Biometric unlock demo, styled as a vault in the app's docs palette (`styles/app.css`, light and dark) for screen recordings: the
 * face-frame glyph carries the state, the readout under the headline shows the raw `status` / `error` the specs
 * assert on (`bio-status`, `bio-error`), the attempt log timestamps every try and the contents drawer rises on
 * unlock. Reachable from Settings or `warden-example://biometrics` (no sign-in gate). Every view a spec reads is
 * `accessible` so its testID is in the AX tree. The main button unlocks, or locks the vault again once it is open.
 * Colours are theme classes; icons take theme colours through `useThemeColor`.
 */
export default function Biometrics() {
	const { status, error, events, unlock, lock } = useBiometricUnlock();
	const insets = useSafeAreaInsets();
	const foreground = useThemeColor("foreground");
	const background = useThemeColor("background");
	const success = useThemeColor("success");
	const faint = useThemeColor("tertiary-foreground");
	const muted = useThemeColor("muted-foreground");

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const latestMatch = events.find((e) => e.kind === "unlocked");
	const copy = copyOf(status, latestMatch?.kind === "unlocked" ? latestMatch.tookMs : undefined);
	const isOpen = status === "Unlocked";
	const isBusy = status === "Scanning" || status === "Checking";
	const action = isOpen ? lock : unlock;
	const actionLabel = isOpen ? "Lock vault" : isBusy ? "Scanning…" : "Unlock with Face ID";
	const { button: buttonClass, label: labelClass } = actionClasses(isOpen, isBusy);

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }} testID="bio-screen">
			<StatusBar style="light" />
			<View className="h-[52px] flex-row items-center justify-between px-5">
				<Pressable
					accessibilityLabel="Back"
					accessibilityRole="button"
					accessible
					className="flex-row items-center gap-1.5"
					hitSlop={12}
					onPress={back}
					testID="bio-back"
				>
					<IconChevronLeft color={foreground} size={22} />
					<Text className="font-heading text-lg text-foreground">Vault</Text>
				</Pressable>
				<IconLock color={isOpen ? success : faint} size={18} />
			</View>

			<ScrollView
				bounces={false}
				contentContainerClassName="gap-[22px] px-6 pb-6"
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
			>
				<View className="items-center pt-2">
					<FaceGlyph status={status} />
					<Text className="font-heading mt-1 text-[34px] text-foreground tracking-tight">{copy.title}</Text>
					<Text className="font-sans mt-1.5 max-w-[300px] text-center text-base leading-[22px] text-muted-foreground">
						{copy.body}
					</Text>
				</View>

				<View className="gap-2 border-border border-y py-3">
					<View className="flex-row justify-between">
						<Text className="font-mono text-[13px] text-tertiary-foreground">status</Text>
						<Text accessible className="font-mono text-[13px] text-foreground" testID="bio-status">
							{status}
						</Text>
					</View>
					<View className="flex-row justify-between">
						<Text className="font-mono text-[13px] text-tertiary-foreground">error</Text>
						<Text accessible className="font-mono text-[13px] text-foreground" testID="bio-error">
							{error}
						</Text>
					</View>
				</View>

				{isOpen && <VaultDrawer />}

				<View className="gap-3.5">
					<Text className="font-heading text-base text-foreground">Attempts</Text>
					<AttemptLog events={events} />
				</View>
			</ScrollView>

			<View className="bg-background px-6 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
				<Pressable
					accessibilityLabel={actionLabel}
					accessibilityRole="button"
					accessibilityState={{ disabled: isBusy }}
					accessible
					className={`h-14 flex-row items-center justify-center gap-2.5 rounded-full active:scale-[0.985] active:opacity-85 ${buttonClass}`}
					disabled={isBusy}
					onPress={action}
					testID="bio-unlock"
				>
					{!isOpen && <IconFaceId color={isBusy ? muted : background} size={20} />}
					<Text className={`font-heading text-[17px] ${labelClass}`}>{actionLabel}</Text>
				</Pressable>
			</View>
		</View>
	);
}
