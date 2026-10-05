import { type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { type EmptyStateContextValue, EmptyStateProvider } from "./empty-state.context";
import { type EmptyStateSize, type EmptyStateVariant, emptyStateVariants } from "./empty-state.variants";
import { EmptyStateContent } from "./empty-state-content";
import { EmptyStateDescription } from "./empty-state-description";
import { EmptyStateHeader } from "./empty-state-header";
import { EmptyStateMedia } from "./empty-state-media";
import { EmptyStateTitle } from "./empty-state-title";

export type EmptyStateProps = ViewProps & {
	/** `default` grows into its parent; `card` is a self-contained dashed block. */
	variant?: EmptyStateVariant;
	/** Drives the padding, both gaps, the media, the glyph and both type scales. */
	size?: EmptyStateSize;
	className?: string;
	children?: ReactNode;
};

function EmptyStateRoot({
	variant = "default",
	size = "md",
	className,
	children,
	...props
}: EmptyStateProps): ReactElement {
	const context = useMemo<EmptyStateContextValue>(() => ({ size, variant }), [size, variant]);

	return (
		<EmptyStateProvider value={context}>
			<View className={emptyStateVariants({ size, variant }).root({ className })} {...props}>
				{children}
			</View>
		</EmptyStateProvider>
	);
}

/**
 * A placeholder for a list or a screen with nothing in it yet: a picture, a
 * title, a line of explanation, and the action that fixes it.
 *
 * `size` and `variant` reach the parts through context, so the title picks its
 * own type scale and a bare `Icon` in `EmptyState.Media` its own size and
 * colour. Actions are composed — put a `Button` in `EmptyState.Content`.
 *
 * `default` grows to fill a bounded parent and centres itself there, without
 * collapsing inside a `ScrollView`. `card` is a dashed block for an empty
 * section sitting beside populated ones.
 *
 * @example
 * <EmptyState>
 *   <EmptyState.Header>
 *     <EmptyState.Media variant="icon">
 *       <Icon icon={IconInbox} />
 *     </EmptyState.Media>
 *     <EmptyState.Title>No messages</EmptyState.Title>
 *     <EmptyState.Description>New conversations will show up here.</EmptyState.Description>
 *   </EmptyState.Header>
 *   <EmptyState.Content>
 *     <Button onPress={compose}>New message</Button>
 *   </EmptyState.Content>
 * </EmptyState>
 *
 * @example
 * <EmptyState size="sm" variant="card">
 *   <EmptyState.Header>
 *     <EmptyState.Title>No results</EmptyState.Title>
 *     <EmptyState.Description>Try a different search.</EmptyState.Description>
 *   </EmptyState.Header>
 * </EmptyState>
 */
export const EmptyState = Object.assign(EmptyStateRoot, {
	/** The centred column holding the media, the title and the description. */
	Header: EmptyStateHeader,
	/** The picture above the title. A bare `Icon` inside it inherits size and colour; `variant="icon"` tints a box behind it. */
	Media: EmptyStateMedia,
	/** The heading, announced as a header. Carries its own colour — a `View` cannot cascade one to a `Text`. */
	Title: EmptyStateTitle,
	/** The supporting line under the title, a step down in scale and on the muted token. */
	Description: EmptyStateDescription,
	/** The action slot under the header: a centred row that wraps. */
	Content: EmptyStateContent,
	displayName: "DelacourUI.EmptyState",
});
