# Card

A content surface with a header, a body and a footer, built on
[`Surface`](../surface/AGENTS.md). Compound root plus six parts: `Header`,
`Title`, `Description`, `Action`, `Content`, `Footer`.

`import { Card } from "@/components/ui/card";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/card` |
| `card.tsx` | Root + the `Object.assign` compound surface |
| `card-header.tsx` | `Card.Header`, and the bare-text wrap it owns |
| `card-title.tsx` | `Card.Title` |
| `card-description.tsx` | `Card.Description` |
| `card-action.tsx` | `Card.Action` |
| `card-content.tsx` | `Card.Content` |
| `card-footer.tsx` | `Card.Footer` |
| `card.context.tsx` | `CardProvider`, `useCard()`, `useCardContext()`, `useCardPart()` |
| `card.types.ts` | Prop types shared by two or more parts |
| `card.variants.ts` | The slotted `tv()`, `resolveCardFooterFill`, `splitCardHeaderChildren` — no RN imports |
| `card.variants.test.ts` | |

## Design

- **The surface is `Surface`'s; the card adds only the rhythm between its
  parts.** Fill, hairline, corner and clip all come from `Surface` at
  `padding="none"`, so `variant` is `Surface`'s four fills with the same
  nesting rule — a card that names none is the hairlined `default` on a screen
  and steps to the next fill inside another surface. A card is not a second
  definition of what a card-shaped surface looks like.
- **The root resolves the fill itself as well as passing it down.** The parts
  need the plane the card landed on — the title's colour and a band footer's
  fill key off it — and `Surface` does not publish a prop it was never given.
  So `Card` runs the same two pure resolvers and hands `Surface` the explicit
  result; the two cannot disagree, because it is one function called twice.
- **Padding lives on the parts, not the root.** The root carries `pt`/`pb`
  and a `gap` of the same step; `Header`, `Content` and `Footer` carry that step as
  `px`. An image written straight into the card therefore reaches both side
  edges with nothing to undo, and `className="pt-0"` on the card bleeds it to
  the top. Content that must not be clipped does not belong in a card: the root
  is `padding="none"`, which is `Surface`'s one clipping step.
- **The root's vertical padding is `pt`/`pb`, never `py`.** The root is the
  surface's view, which carries `p-0` at `padding="none"`, and Uniwind resolves
  that shorthand over a `py-*` on the same view — the first build on a device
  drew the title flush against the top hairline. The longhands win, and a test
  forbids `py-` on the root so it cannot come back.
- **Sizes**: `sm`, `md`, `lg` — insets of 3, 4 and 6, which are `Surface`'s own
  padding steps, so a card and a surface side by side at one size hold their
  content at one distance from the edge. Size is one axis for five numbers —
  vertical padding, gap, horizontal inset, title scale, description scale —
  and the test pins the three insets to each other rather than to numbers.
- **The title is on its plane's foreground token.** `text-card-foreground` on
  the card fill, `text-secondary-foreground` on a secondary card, and
  `text-foreground` for a transparent card on the page. Written out per plane
  in the `tv()`, because Tailwind's scanner cannot see a class built at
  runtime. The description is `muted-foreground` everywhere.
- **`Card.Title` is announced as a header**, so a screen reader's rotor can
  step card to card through a list of them.
- **`Card.Action` is lifted out of the header's text column, wherever it is
  written.** React Native has no grid to place a child by type, so the header
  walks its children with `splitCardHeaderChildren` and renders the text column
  as `flex-1` with the actions after it. The title wraps in the width an action
  leaves instead of pushing it off the edge. The helper takes its predicate as
  an argument so it stays in `card.variants.ts`, free of the part and of React
  Native, and reachable from `bun test`.
- **Bare text in a header is its title.** A raw string inside a `View` is a
  red box, and a header's text is its heading — the same wrap, for the same
  reason, as [`ListGroup.Item`](../list-group/AGENTS.md).
- **Footer variants**: `default`, a wrapping row of actions; `band`, a strip
  set into the card — `border-t`, the next fill down, and the card's bottom
  corners. The band pulls itself down over the root's bottom padding with a
  `-mb-*` of exactly that step and restates it as `py-*`, so it meets the edge
  and the root's clip gives it the corners. That only works as the last child,
  which the doc comment says.
- **A band's fill is a step on the ladder, not a colour.**
  `resolveCardFooterFill` is `resolveSurfaceVariant` for the card's plane — the
  same step a surface nested in the card would take — so a band never matches
  the card it sits in, at any depth. A transparent card on the page has no
  plane, and its band takes the card fill.
- **No interaction on the card.** A card is layout. A card that selects or
  navigates is a `Pressable` around it — `<Pressable asChild>` or a wrapper —
  which keeps `feedback`, `haptic` and the accessibility role at the call site
  that knows what the press means. The playground's plan picker is the example.
- **No text treatment on the root, header, content or footer** (rule 1). The
  tests assert it across every combination.
