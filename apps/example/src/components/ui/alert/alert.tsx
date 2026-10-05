import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import Animated, { FadeOut } from "react-native-reanimated";
import { useControllableState } from "@/hooks/use-controllable-state";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { Surface, type SurfaceProps } from "@/components/ui/surface";
import { type AlertContextValue, AlertProvider } from "./alert.context";
import {
	ALERT_FOREGROUND_TOKEN,
	ALERT_SURFACE_PADDING,
	type AlertSize,
	type AlertStatus,
	type AlertVariant,
	alertVariants,
	resolveAlertLiveRegion,
	resolveAlertSurfaceVariant,
} from "./alert.variants";
import { AlertAction } from "./alert-action";
import { AlertCloseButton } from "./alert-close-button";
import { AlertContent } from "./alert-content";
import { AlertDescription } from "./alert-description";
import { AlertIndicator } from "./alert-indicator";
import { AlertTitle } from "./alert-title";

/** A dismissed alert fades rather than vanishing, so the layout below it has a beat to follow. */
const EXITING = FadeOut.duration(150);

export type AlertProps = Omit<SurfaceProps, "variant" | "padding"> & {
	/** What the alert says: `default`, `info`, `success`, `warning` or `destructive`. Picks the glyph and the colour. */
	status?: AlertStatus;
	/** `soft` washes the surface in the status's colour; `surface` keeps the neutral fill and colours only the glyph and title. */
	variant?: AlertVariant;
	/** Padding, gap, type scale and glyph size together. */
	size?: AlertSize;
	/** Composes a trailing dismiss control in. */
	isDismissible?: boolean;
	/** Whether the alert is shown. Pass it to control the alert; omit it and the alert hides itself when dismissed. */
	isOpen?: boolean;
	/** Whether an uncontrolled alert starts shown. */
	defaultOpen?: boolean;
	/** Called with `false` when the alert is dismissed, controlled or not. */
	onOpenChange?: (isOpen: boolean) => void;
	/** Name a screen reader gives the dismiss control. Defaults to `Dismiss`. */
	closeAccessibilityLabel?: string;
	/** `testID` for the dismiss control, so a test or automation can press it. */
	closeTestID?: string;
	children?: ReactNode;
};

function AlertRoot({
	status = "default",
	variant = "soft",
	size = "md",
	isDismissible = false,
	isOpen,
	defaultOpen = true,
	onOpenChange,
	closeAccessibilityLabel,
	closeTestID,
	className,
	children,
	...props
}: AlertProps): ReactElement | null {
	const [open, setOpen] = useControllableState({ defaultValue: defaultOpen, onChange: onOpenChange, value: isOpen });
	const dismiss = useCallback(() => setOpen(false), [setOpen]);

	const context = useMemo<AlertContextValue>(
		() => ({ dismiss, size, status, variant }),
		[dismiss, size, status, variant]
	);

	const slots = alertVariants({ size, status, variant });

	// A glyph composed anywhere inside — the indicator's own, a `Spinner`, an
	// `Icon` in an action — adopts the alert's step and its status's colour.
	const iconClassName = slots.icon();
	const iconColor = ALERT_FOREGROUND_TOKEN[status];
	const iconDefaults = useMemo(() => ({ className: iconClassName, color: iconColor }), [iconClassName, iconColor]);

	if (!open) {
		return null;
	}

	return (
		<AlertProvider value={context}>
			<Animated.View exiting={EXITING}>
				<Surface
					accessibilityLiveRegion={resolveAlertLiveRegion(status)}
					accessibilityRole="alert"
					className={slots.root({ className })}
					padding={ALERT_SURFACE_PADDING[size]}
					variant={resolveAlertSurfaceVariant({ status, variant })}
					{...props}
				>
					<IconDefaultsProvider value={iconDefaults}>
						{children}
						{isDismissible ? (
							<AlertCloseButton accessibilityLabel={closeAccessibilityLabel} testID={closeTestID} />
						) : null}
					</IconDefaultsProvider>
				</Surface>
			</Animated.View>
		</AlertProvider>
	);
}

/**
 * A status message — a glyph, a title, a description and, optionally, an
 * action — drawn on a `Surface`.
 *
 * `status` says what the message means: `default`, `info`, `success`,
 * `warning` or `destructive`. It picks the indicator's glyph and colours the
 * glyph and the title from one token; the description stays muted whatever the
 * status. `variant` says how loudly: `soft` washes the surface in the status's
 * soft fill, `surface` keeps the neutral fill and lets the glyph and title carry
 * the colour. A neutral or `surface` alert takes its fill from the surface
 * ladder, so one inside a card steps off the card instead of vanishing into it.
 *
 * `isDismissible` composes a close control in. Uncontrolled, the alert hides
 * itself when dismissed; pass `isOpen` and `onOpenChange` to own that state.
 * `useAlert().dismiss` closes it from inside, for a "Got it" action.
 *
 * Announced as an `alert`, and as a live region on Android — assertive for a
 * warning or a failure, polite for anything else.
 *
 * @example
 * <Alert status="warning">
 *   <Alert.Indicator />
 *   <Alert.Content>
 *     <Alert.Title>Card expiring</Alert.Title>
 *     <Alert.Description>The card ending 4242 expires next month.</Alert.Description>
 *   </Alert.Content>
 * </Alert>
 *
 * @example
 * <Alert isDismissible status="destructive">
 *   <Alert.Indicator />
 *   <Alert.Content>
 *     <Alert.Title>Payment failed</Alert.Title>
 *     <Alert.Description>Your bank declined the charge.</Alert.Description>
 *     <Alert.Action>
 *       <Button onPress={retry} size="sm">Try again</Button>
 *     </Alert.Action>
 *   </Alert.Content>
 * </Alert>
 */
export const Alert = Object.assign(AlertRoot, {
	/** The leading status glyph, picked from `status`. Children replace it. */
	Indicator: AlertIndicator,
	/** The column holding the title, description and action; takes the remaining width. */
	Content: AlertContent,
	/** The heading, coloured by the status. */
	Title: AlertTitle,
	/** The body text, always muted. */
	Description: AlertDescription,
	/** A wrapping row of buttons under the description. */
	Action: AlertAction,
	/** The trailing dismiss control. Composed in automatically whenever `isDismissible` is set. */
	CloseButton: AlertCloseButton,
	displayName: "DelacourUI.Alert",
});
