# Chip

An interactive pill — a filter that is on or off, a tag, or a token that can be
removed. Compound root plus `Chip.Label`, `Chip.StartContent`, `Chip.EndContent`
and `Chip.CloseButton`.

`import { Chip } from "@/components/ui/chip";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/chip` |
| `chip.tsx` | Root + the `Object.assign` compound surface |
| `chip-label.tsx` | `Chip.Label` |
| `chip-start-content.tsx` | `Chip.StartContent` |
| `chip-end-content.tsx` | `Chip.EndContent` |
| `chip-close-button.tsx` | `Chip.CloseButton`, the remove pressable |
| `chip.context.tsx` | `ChipContext`, `useChip()`, `useChipContext()`, `useChipPart()` |
| `chip.types.ts` | Prop types shared by two or more parts |
| `chip.variants.ts` | Pure `tv()` slots, the foreground map, hit slops, `resolveChipMode` / `resolveChipSurface` / `resolveChipForegroundToken` — no RN imports |
| `chip.variants.test.ts` | |

## Design

- **What a chip does is read from its props, never from a `type` flag.**
  `resolveChipMode` returns `static`, `button` or `toggle`. No handler is a tag,
  rendered as a plain `View` — a detector under every tag in a list of fifty
  would announce each as a button with no action, the same reason
  [`Badge`](../badge/AGENTS.md) stays inert. `onPress` or `onLongPress` is a
  button. **Any** selection prop — `isSelected` even when `false`,
  `defaultSelected`, `onSelectedChange` — is a toggle, and it outranks a bare
  press handler, because a chip with an on state that is announced as a plain
  button leaves a screen-reader user unable to tell which chips are on. A
  toggle still calls `onPress` after flipping.
- **Selection is announced as `selected`, with the `button` role.** That is the
  native idiom for a filter on both platforms — VoiceOver reads "Selected",
  TalkBack "selected" — and it matches what a system segmented filter reports.
  `checkbox` would promise a box that is not drawn. A caller's own
  `accessibilityState` is merged under it, and `Pressable` merges `disabled` on
  top.
- **Controlled or uncontrolled, through `useControllableState`**, the same hook
  and the same prop shape as [`Checkbox`](../checkbox/AGENTS.md):
  `isSelected` / `defaultSelected` / `onSelectedChange`. A toggle ticks a
  `selection` haptic by default; a button plays none, as a badge does. Pass
  `haptic` to override either.
- **Tone is Badge's, not a copy of it.** `CHIP_COLORS` and `CHIP_SIZES` *are*
  `BADGE_COLORS` and `BADGE_SIZES`, and the resting entries of
  `CHIP_FOREGROUND_TOKEN` are Badge's own objects. The class strings in
  `chipVariants` are restated (Tailwind's scanner is static, so a class has to
  appear literally somewhere), and a test pins every resting cell's `bg-*`,
  `border-*` and label colour to the badge of the same variant and colour. A
  soft `success` chip beside a soft `success` badge is one shade by
  construction.
- **Two resting variants, `soft` and `outline`.** `solid` is what selection
  paints, so a resting solid chip would read as already on; `ghost` has neither
  fill nor border, so there is no edge to aim at. `soft` is the default.
- **Selection is a surface, not a modifier.** `CHIP_SURFACES` is the two resting
  variants plus `selected`, and a selected chip looks the same whichever it rests
  on — a solid fill and matching border in its colour. The `isSelected`
  compound variants sit after the resting ones, so tailwind-merge lets them win.
- **A selected `default` chip inverts** to `bg-foreground` / `text-background`.
  Badge's solid default is `secondary`, which this theme sets a hair from
  `muted` — the soft default — so a selected default chip would look unselected.
  A test asserts all eighteen surface-and-colour cells are distinct.
- **The border is reserved in every state.** A chip toggles in place inside a
  wrapping row; a box that grew two points on selection would reflow every chip
  after it. `overflow-hidden` keeps the pressed fade inside the capsule.
- **Roomier than a badge, and still never a height.** A chip is aimed at and a
  badge is only read, so each size pads at least as generously as the badge of
  that size — a test asserts it. There is no `h-*`, so the label grows with OS
  font scaling. The icon step is Badge's, so a glyph moves between the two
  without changing size.
- **Hit slop is vertical and capped at four points.** Chips wrap with `gap-2`;
  slop past half that gap reaches into the neighbouring row and makes a tap
  between two chips ambiguous. `CHIP_HIT_SLOP` is never horizontal for the same
  reason. The close glyph gets `CHIP_CLOSE_HIT_SLOP` on every side instead — it
  is 14–18 points, and its slop only reaches into its own chip's padding.
- **`onClose` is its own pressable, never a mode of the root.** The remove
  control is a `Chip.CloseButton` composed in last, so its tap is claimed by the
  inner detector and never also toggles the chip. It presses with `fade` —
  a spring on a glyph that small reads as a jitter — and inherits the current
  surface's colour, so it turns with the label on selection.
- **On a pressable chip, removal is an accessibility action, not a second
  element.** iOS folds every descendant of an accessible view into one element,
  so a close control inside a button or toggle chip was unreachable by swipe and
  its label was read as part of the chip's — "React Native, Remove React
  Native". `resolveChipCloseExposure` decides: a static chip leaves the close
  control as its own element; a pressable one hides it
  (`accessibilityElementsHidden`, `no-hide-descendants`) and adds a `remove`
  action, labelled by `closeAccessibilityLabel`, that calls `onClose` —
  VoiceOver's Actions rotor, TalkBack's actions menu. A caller's own
  `accessibilityActions` are kept beside it.
- **`closeTestID` reaches the composed close control.** The root's own `testID`
  names the chip; the close part is a separate pressable with no id of its own
  unless the root forwards one, so a flow or test could only find it by its label.
  `closeTestID` is named like `closeAccessibilityLabel`, the other prop the root
  passes through to it.
- **`self-start` is Badge's, and beside a taller sibling in a row it top-aligns
  the chip.** It is what keeps a chip content-sized in a column, which is the
  common case; in a `flex-row items-center` holding something taller — a
  `Switch` — pass `className="self-center"`, which tailwind-merge lets win. The
  playground's `controlled-and-uncontrolled` demo does exactly this.
- **Icons are composed, never passed as props.** The root wraps its subtree in an
  `IconDefaultsProvider` and a `TextClassProvider` resolved from the *current*
  surface, so a bare `<Icon>` or `<Text>` follows the chip into and out of
  selection. `useChip()` exposes `isSelected` for a custom child that needs more.
- **String children** are wrapped in a `Chip.Label` automatically, consecutive
  strings collapsing into one — the same rule as [`Badge`](../badge/AGENTS.md).
- **No group, yet.** Single- and multi-select filter rows are composed from
  controlled chips (the playground's `filter-row` demo). A `Chip.Group` owning
  the value, as `Checkbox.Group` does, is the obvious next step once a second
  caller needs it.
