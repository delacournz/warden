import { type ReactElement, useMemo } from "react";
import { Surface, type SurfaceProps, useSurfaceContext } from "@/components/ui/surface";
import { resolveSurfacePlane, resolveSurfaceVariant } from "@/components/ui/surface/surface.variants";
import { type CardContextValue, CardProvider } from "./card.context";
import { type CardSize, cardVariants } from "./card.variants";
import { CardAction } from "./card-action";
import { CardContent } from "./card-content";
import { CardDescription } from "./card-description";
import { CardFooter } from "./card-footer";
import { CardHeader } from "./card-header";
import { CardTitle } from "./card-title";

export type CardProps = Omit<SurfaceProps, "padding"> & {
	/** The inset, the gaps between the parts, and the title and description scale. */
	size?: CardSize;
};

function CardRoot({ variant, size = "md", className, children, ...props }: CardProps): ReactElement {
	const parentPlane = useSurfaceContext()?.plane ?? null;

	// Resolved here as well as inside `Surface`, because the parts need the plane
	// the card landed on — the title's colour and a band footer's fill key off it.
	const resolved = resolveSurfaceVariant({ parentPlane, variant });
	const plane = resolveSurfacePlane({ parentPlane, variant: resolved });

	const context = useMemo<CardContextValue>(() => ({ plane, size, variant: resolved }), [plane, size, resolved]);

	return (
		<CardProvider value={context}>
			<Surface className={cardVariants({ size }).root({ className })} padding="none" variant={resolved} {...props}>
				{children}
			</Surface>
		</CardProvider>
	);
}

/**
 * A content surface with a header, a body and a footer.
 *
 * Built on `Surface`, so it takes the same four fills and steps the same way:
 * a card that names no variant is the hairlined `default` at the top of a
 * screen and the next fill down inside another surface. The root is
 * `padding="none"`, which clips — the padding lives on the parts, so an image
 * placed straight in the card reaches its side edges, and `className="pt-0"`
 * bleeds it to the top.
 *
 * `size` reaches every part through context, so the header, the body and the
 * footer line up on one inset and the title picks its own scale and colour —
 * a React Native `View` cannot cascade either to a `Text`.
 *
 * @example
 * <Card>
 *   <Card.Header>
 *     <Card.Title>Monthly report</Card.Title>
 *     <Card.Description>Revenue and retention for October.</Card.Description>
 *     <Card.Action>
 *       <Badge>New</Badge>
 *     </Card.Action>
 *   </Card.Header>
 *   <Card.Content>
 *     <Text.Title>$48,120</Text.Title>
 *   </Card.Content>
 *   <Card.Footer>
 *     <Button size="sm" variant="outline">Export</Button>
 *     <Button size="sm">Open</Button>
 *   </Card.Footer>
 * </Card>
 *
 * @example
 * <Card className="pt-0">
 *   <Image className="h-40 w-full" source={cover} />
 *   <Card.Header>
 *     <Card.Title>Lake Tekapo</Card.Title>
 *   </Card.Header>
 *   <Card.Footer variant="band">
 *     <Button size="sm">Book</Button>
 *   </Card.Footer>
 * </Card>
 */
export const Card = Object.assign(CardRoot, {
	/** The opening block. Stacks a title and description, and pins any `Card.Action` to the top right. */
	Header: CardHeader,
	/** The card's heading, on its plane's foreground token. Announced as a header. */
	Title: CardTitle,
	/** The muted supporting line under the title. */
	Description: CardDescription,
	/** A control pinned to the header's top-right corner, wherever in the header it is written. */
	Action: CardAction,
	/** The card's body, inset to line up with the header and footer. */
	Content: CardContent,
	/** The last row — a row of actions, or with `variant="band"` a strip set into the card. */
	Footer: CardFooter,
	displayName: "DelacourUI.Card",
});
