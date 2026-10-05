# Alert

A status message on a `Surface`: a glyph picked from its status, a title, a
description and, optionally, an action row and a dismiss control. Compound root
plus `Alert.Indicator`, `Alert.Content`, `Alert.Title`, `Alert.Description`,
`Alert.Action` and `Alert.CloseButton`.

`import { Alert } from "@/components/ui/alert";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/alert` |
| `alert.tsx` | Root + the `Object.assign` compound surface |
| `alert-indicator.tsx` | `Alert.Indicator`, and the status → glyph map |
| `alert-content.tsx` | `Alert.Content` |
| `alert-title.tsx` | `Alert.Title` |
| `alert-description.tsx` | `Alert.Description` |
| `alert-action.tsx` | `Alert.Action` |
| `alert-close-button.tsx` | `Alert.CloseButton`, the dismiss pressable |
| `alert.context.tsx` | `AlertProvider`, `useAlert()`, `useAlertContext()`, `useAlertPart()` |
| `alert.types.ts` | `AlertSlotProps`, shared by `Content` and `Action` |
| `alert.variants.ts` | The slotted `tv()`, `ALERT_FOREGROUND_TOKEN`, `ALERT_SURFACE_PADDING` and three pure resolvers — no RN imports |
| `alert.variants.test.ts` | |

## Design

- **Two axes: `status` and `variant`.** `status` says what the message means —
  `default`, `info`, `success`, `warning`, `destructive` — and `variant` says
  how loudly: `soft` (the default) washes the surface in the status's `-soft`
  fill, `surface` keeps a neutral fill and lets the glyph and title carry the
  colour. **Sizes**: `sm`, `md`, `lg`, which move padding, gap, type and glyph
  together. `destructive` rather than `danger`, per the package's token rule.
- **It is built on `Surface`, and it adds only what a surface lacks.** The
  corner, the continuous curve, the padding (`ALERT_SURFACE_PADDING` maps each
  size onto the surface's own step) and the neutral fill all come from
  [Surface](../surface/AGENTS.md). `alertVariants`' root carries the row and the
  tint, and a test asserts it sets no padding of its own — a second one would
  fight the surface's through the merge.
- **Only a tinted alert names a fill.** `resolveAlertTinted` is true for `soft`
  plus a status, and those four cells swap `bg-card` for `bg-X-soft` and clear
  the card's hairline: a grey rule around a red wash reads as two components
  stacked. Every other alert leaves the surface's `variant` undefined
  (`resolveAlertSurfaceVariant`), so it steps from the plane it sits on — an
  alert inside a card lands on `secondary` rather than vanishing into the card.
  A tinted alert pins the surface to `default` instead, so what nests in it
  steps from a card like anything else.
- **One colour token per status, not per status and variant.**
  `ALERT_FOREGROUND_TOKEN` names `X-soft-foreground` for each status and the
  page's `foreground` for `default`; those are tuned to read on the soft fill
  and on the neutral fills alike. The title slot emits the same token as a
  class and the root publishes it through `IconDefaultsProvider`, so the glyph
  and the title are always one shade. A test pins the pair and asserts every
  token exists in both themes. The classes are written out literally —
  Tailwind's scanner is static, so a class assembled from the map at runtime
  would never be compiled.
- **The description is always muted.** A long explanation under a red title
  must not shout; the title carries the status.
- **`items-start`, and the indicator is as tall as the title's line.** A
  description that wraps to four lines must not drag the glyph to its middle.
  The indicator's height is the title's line height at each size (`h-5`/`h-6`/
  `h-7` against `text-sm`/`base`/`lg`), and it centres the glyph in that box, so
  the glyph sits level with the first line. Nothing else is a fixed height:
  `Text` respects OS font scaling, and a fixed box would clip a wrapped title.
- **Glyphs differ in shape, not just colour.** `warning` is a triangle and
  `destructive` a circle, so the two stay apart for anyone who cannot tell amber
  from red. `default` shares `info`'s circle. The map lives in
  `alert-indicator.tsx` because the glyphs are RN SVG components and
  `alert.variants.ts` must stay importable from `bun test`.
- **The indicator is hidden from assistive technology.** The title says what
  happened; "image" announced before it adds nothing. Children replace the
  glyph and inherit the alert's icon size and colour — a `Spinner` for a
  pending state needs nothing else.
- **Announced as an `alert`, and as a live region on Android.**
  `resolveAlertLiveRegion` makes a `warning` or `destructive` alert assertive
  and anything else polite. The root is not made `accessible`: grouping it
  would swallow the close control and any action into one element.
- **Dismissal is controllable.** `isDismissible` composes an
  `Alert.CloseButton` in at the end. Uncontrolled, the alert hides itself when
  dismissed (`defaultOpen`); pass `isOpen` with `onOpenChange` to own it.
  `useAlert().dismiss` is on the context so an action ("Got it") can close the
  alert without the caller threading a setter down. A dismissed alert fades out
  over 150 ms rather than vanishing — the one `Animated.View` wrapper exists for
  that `exiting`, and a caller's `className` still reaches the surface.
- **The close glyph is muted, not the status colour.** The control is about the
  alert rather than part of what it says, and a red cross beside a red title
  reads as a second warning. It presses with `fade` — a spring on a glyph that
  small is a jitter — and carries `hitSlop={10}` to reach the 44-point target.
- **`closeTestID` reaches the composed close control.** The root's own `testID`
  names the alert's surface; the close part is a separate pressable with no id of its own
  unless the root forwards one, so a flow or test could only find it by its label.
  `closeTestID` is named like `closeAccessibilityLabel`, the other prop the root
  passes through to it.
- **Actions are the caller's.** `Alert.Action` is a wrapping row and styles
  nothing in it; a `Button` in there is sized and painted however the caller
  says. It wraps rather than overflowing, because two buttons and a long label
  outgrow a phone's width.
- **Parts are composed, not configured.** There is no `title` or `icon` prop:
  omit `Alert.Indicator` for a text-only alert, omit `Alert.Description` for a
  one-liner. The same reason `Button` and `Badge` compose their icons.
