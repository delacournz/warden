# Item

A row of media, text and actions, for lists and settings. Compound root plus
`Item.Media`, `Item.Content`, `Item.Title`, `Item.Description`, `Item.Actions`,
`Item.Header` and `Item.Footer`, and two layout parts, `Item.Group` and
`Item.Separator`.

`import { Item } from "@/components/ui/item";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/item` |
| `item.tsx` | Root + the `Object.assign` compound surface, and the bare-text wrap it owns |
| `item-media.tsx` | `Item.Media` |
| `item-content.tsx` | `Item.Content` |
| `item-title.tsx` | `Item.Title` |
| `item-description.tsx` | `Item.Description` |
| `item-actions.tsx` | `Item.Actions` |
| `item-header.tsx` | `Item.Header` |
| `item-footer.tsx` | `Item.Footer` |
| `item-group.tsx` | `Item.Group` |
| `item-separator.tsx` | `Item.Separator` |
| `item.context.tsx` | `ItemProvider`, `useItem()`, `useItemContext()`, `useItemPart()` |
| `item.types.ts` | Prop types shared by two or more parts |
| `item.variants.ts` | Pure `tv()` slots and the four resolvers, no RN imports |
| `item.variants.test.ts` | |

## Design

- **Axes**: `variant` — `default`, `outline`, `muted`; `size` — `sm`, `md`,
  `lg`; `orientation` — `horizontal`, `vertical`. States: `isDisabled`,
  `isSelected`, and `busy` inherited from `Pressable`. `Item.Media` has its own
  `variant` — `default`, `icon`, `image`.
- **It drops into a `ListGroup` as a row, and that is the point of it.** An item
  reads the group's context through the `list-group.context` leaf (rule 3 —
  never `../list-group`) and changes three things when it finds one:
  - **The surface becomes `grouped`.** `resolveItemSurface` ignores the variant:
    the group draws the border, fill and corner, and a row repeating any of them
    would draw a card inside a card. `surface` rather than `variant` is the
    `tv()` axis for that reason.
  - **Size defaults to the group's.** `resolveItemSize` — own, else group, else
    `md`. The two components share the `sm`/`md`/`lg` scale on purpose.
  - **Press feedback defaults to `fade`**, not `scale` — a full-bleed row that
    scales reads as the whole card flexing. `resolveItemFeedback`.
- **Row metrics are `ListGroup`'s, number for number.** The group insets each
  divider by its own row padding, so an item padded differently would sit with
  its text and its divider out of line. The tests assert the item's `min-h`,
  `gap`, `px` and `py` against `listGroupVariants().item()` at every size, and
  the bare media icon against the group's `prefixIcon` — change one without the
  other and `bun test` fails by name.
- **Pressable only with a handler.** `resolveItemRender` returns one of two:
  `pressable` (a handler — a `Pressable`, role `button`, children merged into
  one accessible element; disabled, it keeps the role, reports `disabled` and
  dims through `opacity-50`, which `Pressable` composes with its press
  animation) or `static` (no handler — a plain `Animated.View` with no role, so
  a static row never announces itself as a button). The plain branch is
  `Animated.View` rather than `View` so the `ref` type is one type.
- **A pressable item must not hold another control.** iOS merges an accessible
  element's children into it, so a `Button` in the actions of a pressable item
  is unreachable by VoiceOver. Either leave the item static and let the actions
  be the controls, or make the row the control: a switch row takes
  `accessibilityRole="switch"` and `accessibilityState={{ checked }}` on the
  item, toggles from its `onPress`, and renders the `Switch` inside for show.
- **`isSelected` lays `bg-accent` over any surface**, the muted fill included —
  declared after `surface` in the `tv()` so tailwind-merge drops the losing
  `bg-*`. It also sets `accessibilityState.selected`. What marks the choice (a
  check, a radio) is composed into `Item.Actions` by the caller.
- **Icons are composed, never passed as props.** `Item.Media` and
  `Item.Actions` each wrap their subtree in an `IconDefaultsProvider`. Media
  gets the foreground token at the size its variant calls for — a bare icon
  matches a `ListGroup` prefix, an `icon` tile's glyph sits two steps smaller
  inside it. Actions gets `muted-foreground` a step lower still, so a chevron
  reads as a hint. A `Button` in the actions publishes its own defaults and is
  unaffected.
- **`Header` and `Footer` work on both orientations.** The horizontal root is
  `flex-wrap` and the strips are `w-full`, so a strip takes a line of its own
  above or below media, text and actions without the item having to become a
  column.
- **`Content` only flexes along a row.** Vertical, it is `self-stretch`: a
  `flex-1` column in an auto-height parent collapses to zero in Yoga.
- **`Item.Group` is spaced, not divided.** It is for standalone items — outlined
  cards, a carousel — announced with `accessibilityRole="list"`. Rows sharing
  one card with dividers belong in a `ListGroup`, which already does both.
  `Item.Separator` is a `Separator` under the item's name, for the occasional
  hand-placed rule in a group.
- **String children** are wrapped in a `Content` around a `Title`, consecutive
  strings collapsing into one — the same rule, and the same reason, as
  [`ListGroup`](../list-group/AGENTS.md).
- **Text colour goes on the text.** No slot but `title` and `description` holds
  a `text-*` colour; the tests assert the root never does.
