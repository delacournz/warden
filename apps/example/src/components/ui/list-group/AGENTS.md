# ListGroup

A surface grouping related rows. Compound root plus `ListGroup.Item` and its
five slots: `ItemPrefix`, `ItemContent`, `ItemTitle`, `ItemDescription`,
`ItemSuffix`.

`import { ListGroup } from "@/components/ui/list-group";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/list-group` |
| `list-group.tsx` | Root + the `Object.assign` compound surface |
| `list-group-item.tsx` | `ListGroup.Item`, and the bare-text wrap it owns |
| `list-group-item-prefix.tsx` | `ListGroup.ItemPrefix` |
| `list-group-item-content.tsx` | `ListGroup.ItemContent` |
| `list-group-item-title.tsx` | `ListGroup.ItemTitle` |
| `list-group-item-description.tsx` | `ListGroup.ItemDescription` |
| `list-group-item-suffix.tsx` | `ListGroup.ItemSuffix` |
| `list-group.context.tsx` | `ListGroupProvider`, `useListGroup()`, `useListGroupContext()`, `useListGroupPart()` |
| `list-group.types.ts` | Prop types shared by two or more parts |
| `list-group.variants.ts` | Pure `tv()` slots, no RN imports |
| `list-group.variants.test.ts` | |

## Design

- **Variants**: `default`, `secondary`, `tertiary`, `transparent`.
  **Sizes**: `sm`, `md`, `lg`. Size is not decoration — it drives the row
  metrics, the title and description type scale, both icon sizes *and* the
  divider inset, which is why those five numbers live in one axis rather than
  five magic values.
- **The corner is `rounded-md`, the 0.8 step of the shared ramp.** shadcn puts a
  grouped surface a step or two below a card, so a group reads as a control
  surface rather than as one. Size does not move it, and neither does a button's
  own corner — `--radius-button-*` is a capsule at half its height and outside
  this ramp. See the corner-scale note in
  [the package AGENTS.md](../../../AGENTS.md).
- **Dividers are inserted, not written out.** The root walks its children and
  puts a [`Separator`](../separator/AGENTS.md) between adjacent ones, inset to
  line up with the rows' padding. A `Separator` placed by hand suppresses the
  automatic one on either side of it, so a caller can make one gap full-bleed
  without turning the feature off; `isDivided={false}` turns it off entirely.
  `Children.toArray` drops the nulls a conditional child leaves behind, so a row
  rendered only some of the time does not strand a divider.
- **The root clips.** `overflow-hidden` is load-bearing: a pressed row fades to
  the edge of its own box, and the first and last rows would square off the
  group's corners without it.
- **A row is a `Pressable`.** `ListGroupItemProps` extends `PressableProps`, so
  `feedback`, `haptic`, `pressedScale` and the rest are inherited rather than
  restated — the row owns no vocabulary of its own. Only the default differs:
  `feedback` defaults to `fade`, because a full-bleed row that scales reads as
  the whole card flexing rather than as one row responding. A prop is only
  redeclared where it genuinely changes, as [`Button`](../button/AGENTS.md) does
  with its narrower union; redeclaring one unchanged just to hang a doc comment
  on it puts a second definition in the tree that can drift.
- **Icons are composed, never passed as props.** `ItemPrefix` wraps its subtree
  in an `IconDefaultsProvider` carrying the `prefixIcon` slot — a step on the
  shared icon scale, like every other glyph in the library — and `foreground`,
  so a bare `<Icon icon={IconUser} />` needs nothing said at the call site.
  `ItemSuffix` draws a chevron when it has no children of its own; `iconProps`
  tunes that glyph and is ignored once it does.
- **String children** are wrapped in an `ItemContent` around an `ItemTitle`
  automatically, consecutive strings collapsing into one — the same rule, and
  the same reason, as [`Button`](../button/AGENTS.md).
- **Title colour goes on the title.** The `item` slot carries no `text-*`; a row
  is a `View` and cannot cascade colour to a `Text`. The tests assert this.
