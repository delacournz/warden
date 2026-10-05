# Badge

A compact label for status, category or count. Compound root plus `Badge.Label`,
`Badge.StartContent`, `Badge.EndContent` and `Badge.CloseButton`.

`import { Badge } from "@/components/ui/badge";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/badge` |
| `badge.tsx` | Root + the `Object.assign` compound surface |
| `badge-label.tsx` | `Badge.Label` |
| `badge-start-content.tsx` | `Badge.StartContent` |
| `badge-end-content.tsx` | `Badge.EndContent` |
| `badge-close-button.tsx` | `Badge.CloseButton`, the dismiss pressable |
| `badge.context.tsx` | `BadgeContext`, `useBadge()`, `useBadgeContext()`, `useBadgePart()` |
| `badge.types.ts` | Prop types shared by two or more parts |
| `badge.variants.ts` | Pure `tv()` slots + `resolveBadgeInteractive`, no RN imports |
| `badge.variants.test.ts` | |

## Design

- **Two axes, not one.** `variant` says how the surface is painted — `solid`,
  `soft`, `outline`, `ghost` — and `color` says what it means — `default`,
  `primary`, `success`, `warning`, `destructive`, `info`. **Sizes**: `sm`, `md`, `lg`.
  [`Button`](../button/AGENTS.md) collapses the two into a single enum, and a
  badge deliberately does not: six semantic colours are the point of this
  component rather than an afterthought, and one axis would need thirteen names
  to say what two say with ten. Neither axis paints a surface alone, so all
  twenty-four pairings live in `compoundVariants`; a test asserts every cell is
  distinct, because two cells collapsing means a caller can set an axis and see
  nothing change.
- **A badge is content until it is given something to do.** With no `onPress`
  and no `onLongPress` the root is a plain `View`. Mounting a `GestureDetector`
  regardless would put one under every tag in a list of fifty and announce each
  of them to assistive technology as a button with no action. `resolveBadgeInteractive`
  is that decision, and it is pure so `bun test` reaches it. Supply either
  handler and the root becomes a [`Pressable`](../pressable/AGENTS.md),
  inheriting `feedback`, `haptic` and the rest; only the default differs,
  `scale`.
- **`onClose` is its own pressable, never a mode of the root.** The dismiss
  control is a `Badge.CloseButton` composed in at the end, so its tap is claimed
  by the inner detector and never also fires the badge's `onPress`. It presses
  with `fade` rather than the root's `scale` — a spring on a glyph that small
  reads as a jitter. Reach for the part by hand only to place it somewhere other
  than last.
- **`closeTestID` reaches the composed close control.** The root's own `testID`
  names the badge; the close part is a separate pressable with no id of its own
  unless the root forwards one, so a flow or test could only find it by its label.
  `closeTestID` is named like `closeAccessibilityLabel`, the other prop the root
  passes through to it.
- **A size is padding, never a height.** `Text` respects OS font scaling, so a
  fixed height clips the label at a large accessibility step instead of growing
  with it — and unlike `h-button-*` or `h-navbar-row`, a badge lines up against
  no chrome that would force the number. A test asserts the root carries no
  `h-*` at any size. The icon step indexes the shared `--spacing-icon-*` scale,
  so a glyph in a badge matches every other glyph in the library.
- **`self-start` is load-bearing.** A badge is sized by its content, and inside a
  gap column every child is stretch-aligned by default — without it a one-word
  badge spans the whole screen.
- **The border is reserved on every variant, transparent until `outline`
  colours it.** Declaring it only where it shows would make the badge two points
  wider the moment a caller switched variant. `overflow-hidden` is likewise not
  tidiness: a pressed badge fades to the edge of its own capsule.
- **The neutral end of the matrix reuses tokens the theme already has.** This
  theme's `primary` is a near-black whose tint *is* the neutral fill, so a
  `--primary-soft` would duplicate `secondary` exactly. `soft` takes
  `tertiary` for `primary` and `muted` for `default` instead — two fills the
  theme already tunes per mode. The four semantic colours did get real tokens:
  `success-soft`, `warning-soft` and `info-soft` joined the existing
  `destructive-soft` in `theme.css`, foregrounds included.
- **`BADGE_FOREGROUND_TOKEN` is nested, `Record<variant, Record<color, string>>`,**
  so adding a colour is a compile error in four places rather than a silent gap
  in one. A test pins each entry to the token its own `label` slot resolves to —
  two maps that can drift is how a badge ends up with a grey glyph beside white
  text — and asserts every token it names is declared in **both** variants of
  `theme.css`.
- **Icons are composed, never passed as props**, the way
  [`Button`](../button/AGENTS.md) does it. The root wraps its subtree in an
  `IconDefaultsProvider` and a `TextClassProvider`, so a bare `<Icon>` or
  `<Text>` inside a badge comes out at the right size and colour with nothing
  said at the call site. One text treatment covers the whole subtree, which is
  the condition [Text](../text/AGENTS.md) sets for publishing into the cascade.
- **String children** are wrapped in a `Badge.Label` automatically, consecutive
  strings collapsing into one — the same rule, and the same reason, as
  [`Button`](../button/AGENTS.md).
