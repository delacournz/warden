import { IconChevronLeft } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";

type ShowcaseProps = {
	/** Screen testID, e.g. `bio-screen`. */
	testID: string;
	/** Navbar title beside the back chevron. */
	title: string;
	backTestID: string;
	/** Status icon at the navbar's right edge. */
	trailing?: ReactNode;
	children: ReactNode;
};

/**
 * The shell every showcase screen shares (biometrics, network, location, clock), built to be screen-recorded:
 * navbar row, a scrolling body (`Showcase.Body`) and one pinned primary action (`Showcase.Footer` +
 * `Showcase.Action`). Back pops, or goes home when the screen was opened by deep link.
 */
function ShowcaseRoot({ testID, title, backTestID, trailing, children }: ShowcaseProps) {
	const insets = useSafeAreaInsets();
	const foreground = useThemeColor("foreground");
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }} testID={testID}>
			<StatusBar style="auto" />
			<View className="h-navbar-row flex-row items-center justify-between px-5">
				<Pressable
					accessibilityLabel="Back"
					accessibilityRole="button"
					accessible
					className="flex-row items-center gap-1.5"
					hitSlop={12}
					onPress={back}
					testID={backTestID}
				>
					<IconChevronLeft color={foreground} size={22} />
					<Text className="font-heading text-lg text-foreground">{title}</Text>
				</Pressable>
				{trailing}
			</View>
			{children}
		</View>
	);
}

/** The scrolling column between the navbar and the footer. */
function ShowcaseBody({ children }: { children: ReactNode }) {
	return (
		<ScrollView
			bounces={false}
			contentContainerClassName="gap-5 px-6 pb-6"
			showsHorizontalScrollIndicator={false}
			showsVerticalScrollIndicator={false}
		>
			{children}
		</ScrollView>
	);
}

type HeroProps = {
	/** The glyph that carries the state. */
	glyph: ReactNode;
	title: string;
	body: string;
	/** testID on the headline, for specs that assert the state in words. */
	titleTestID?: string;
};

/** The glyph, the state as a headline and one supporting line. */
function ShowcaseHero({ glyph, title, body, titleTestID }: HeroProps) {
	return (
		<View className="items-center pt-2">
			{glyph}
			<Text accessible className="font-heading mt-1 text-4xl text-foreground tracking-tight" testID={titleTestID}>
				{title}
			</Text>
			<Text className="font-sans mt-1.5 max-w-xs text-center text-base leading-snug text-muted-foreground">{body}</Text>
		</View>
	);
}

/** Hairline-ruled block of raw values: what the specs assert, shown as-is. */
function ShowcaseReadout({ children }: { children: ReactNode }) {
	return <View className="gap-2 border-border border-y py-3">{children}</View>;
}

/** One readout row: label left, the raw value right (the value carries the testID). */
function ShowcaseReadoutRow({ label, value, testID }: { label: string; value: string; testID: string }) {
	return (
		<View className="flex-row justify-between gap-4">
			<Text className="font-mono text-sm text-tertiary-foreground">{label}</Text>
			<Text accessible className="shrink font-mono text-sm text-foreground" numberOfLines={1} testID={testID}>
				{value}
			</Text>
		</View>
	);
}

/** A titled block in the body, e.g. the event log. */
function ShowcaseSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<View className="gap-3.5">
			<Text className="font-heading text-base text-foreground">{title}</Text>
			{children}
		</View>
	);
}

/** Pinned under the body, clear of the home indicator. */
function ShowcaseFooter({ children }: { children: ReactNode }) {
	const insets = useSafeAreaInsets();
	return (
		<View className="gap-3 bg-background px-6 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
			{children}
		</View>
	);
}

/** `solid` is the next step, `outline` undoes one, `busy` waits on the device. */
export type ActionVariant = "solid" | "outline" | "busy";

const ACTION_CLASSES = {
	solid: { button: "bg-foreground", label: "text-background" },
	outline: { button: "border border-border bg-transparent", label: "text-foreground" },
	busy: { button: "bg-card", label: "text-muted-foreground" },
} as const satisfies Record<ActionVariant, { button: string; label: string }>;

type ActionProps = {
	label: string;
	variant: ActionVariant;
	onPress: () => void;
	testID: string;
	/** Drawn before the label; receives the label colour. */
	icon?: (color: string | undefined) => ReactNode;
};

/** The screen's one primary action: a full-width capsule. Disabled while `busy`. */
function ShowcaseAction({ label, variant, onPress, testID, icon }: ActionProps) {
	const background = useThemeColor("background");
	const foreground = useThemeColor("foreground");
	const muted = useThemeColor("muted-foreground");
	const isBusy = variant === "busy";
	const classes = ACTION_CLASSES[variant];
	const iconColor = variant === "solid" ? background : isBusy ? muted : foreground;

	return (
		<Pressable
			accessibilityLabel={label}
			accessibilityRole="button"
			accessibilityState={{ disabled: isBusy }}
			accessible
			className={`h-14 flex-row items-center justify-center gap-2.5 rounded-full active:scale-98 active:opacity-85 ${classes.button}`}
			disabled={isBusy}
			onPress={onPress}
			testID={testID}
		>
			{icon?.(iconColor)}
			<Text className={`font-heading text-lg ${classes.label}`}>{label}</Text>
		</Pressable>
	);
}

export const Showcase = Object.assign(ShowcaseRoot, {
	Body: ShowcaseBody,
	Hero: ShowcaseHero,
	Readout: Object.assign(ShowcaseReadout, { Row: ShowcaseReadoutRow }),
	Section: ShowcaseSection,
	Footer: ShowcaseFooter,
	Action: ShowcaseAction,
});
