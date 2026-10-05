# Text

The library's type scale, and the one component that reproduces React Native's
own text inheritance through classNames. Compound root plus twelve presets:
`Display`, `Title`, `Header`, `Subheader`, `Paragraph`, `Label`, `Caption`,
`Overline`, and the four inline ones — `Strong`, `Emphasis`, `Link`, `Code`.

`import { Text } from "@/components/ui/text";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/text` |
| `text.tsx` | Root, all twelve presets, the `Object.assign` surface — the pure-preset carve-out to one file per part, see [Compound component layout](../../../AGENTS.md#compound-component-layout) |
| `text.context.tsx` | `TextClassProvider`, `useTextClass()` |
| `text.variants.ts` | Pure `tv()` + `resolveTextClass`, no RN imports |
| `text.variants.test.ts` | |

## Design

- **Every `Text` publishes its resolved class to its subtree**, and merges the
  one it inherited. Natively a nested `<Text>` inherits the parent's *style
  object* and overrides only the keys it sets; Uniwind compiles each `className`
  independently, so the parent's resolved class has to be threaded through and
  beaten per-axis instead. `resolveTextClass` is that chain, weakest first:
  `TEXT_BASE_CLASS`, the inherited class, this text's named axes, the caller's
  `className`. It is the ladder `resolveIconSizeClass` already follows.
- **`textVariants` has no `defaultVariants`, and must not gain any.** An axis the
  caller did not name has to emit *nothing* so it falls through to the enclosing
  text's class — that fall-through is the whole feature. A default would emit
  from inside the same call, ahead of the inherited class in the merge, and every
  nested `Text` would snap back to it. `iconVariants` carries the same rule for
  the same reason. The fallback lives in `TEXT_BASE_CLASS` instead.
- **`TEXT_BASE_CLASS` is applied unconditionally**, never guarded behind "am I
  nested". Under true nesting it is a no-op — the parent's string already names
  every axis, so tailwind-merge drops it. It only does work under a *partial*
  provider, a [`Button`](../button/AGENTS.md) publishing nothing but `text-primary-foreground`, where
  guarding it would leave a nested `Text` with a colour and no size at all,
  collapsing to React Native's own 14pt default.
- **The correctness property is a fixpoint**: for every class this resolver can
  produce, a nested `Text` with no props of its own resolves to *exactly* its
  parent's string, at any depth. The tests assert it across the matrix. Anything
  that breaks it makes inheritance lossy in a way only a screen would reveal.
- **A variant names type, never a line height.** tailwind-merge lists `leading`
  among `font-size`'s conflicting groups, so a `text-lg` from the `size` axis
  silently deletes a `leading-6` written beside a `text-base` — no error, just a
  paragraph that loses its leading when someone resizes it. Tailwind v4's
  `--text-*--line-height` companions survive `tokens.css`'s size-only overrides,
  so every step already carries a paired leading. Prose needing its own gets a
  `--text-paragraph` / `--text-paragraph--line-height` **pair**, registered in
  `tokens.ts` — one utility carrying both.
- **`color` is page-level only — no `-foreground` family.** `X-foreground` means
  "content drawn on an `X` surface" (rule 10), and mapping a surface variant to
  its foreground is already each surface component's job
  (`BUTTON_FOREGROUND_TOKEN`, `LIST_GROUP_FOREGROUND_TOKEN`). A second copy of
  that map here could drift from it. Text on a coloured surface writes the
  utility in a `className`.
- **`align` is `left`/`center`/`right`, never `start`/`end`.** React Native's
  `textAlign` accepts `auto | left | right | center | justify` and nothing else,
  so Tailwind v4's logical-property utilities resolve to a value RN rejects.
  `transform: "none"` emits `normal-case` rather than an empty string, so it can
  actually clear an `Overline`'s `uppercase`.
- **A nested `Text.Code` cannot be padded.** A nested `<Text>` is laid out by the
  platform's text engine — an `NSAttributedString` run on iOS, a `Span` on
  Android — and both ignore padding, margin and border radius on an inner
  `<Text>`. Only the background survives. The compound variant applies the pill
  treatment to the standalone case only; a code *block* is a `View` the caller
  wraps around it.
- **Anything can publish into the cascade, not just a `Text`.** [`Button`](../button/AGENTS.md) wraps
  its children in a `TextClassProvider` carrying the label's treatment beside the
  `IconDefaultsProvider` it already renders, so a bare `<Text>` composed into one
  needs nothing at the call site — the payoff [`Icon`](../icon/AGENTS.md) already had. Publish a
  treatment only where **one** covers the whole subtree: a [`ListGroup`](../list-group/AGENTS.md) row
  (title + description), a navbar (title + subtitle) and [`Screen.Error`](../screen/AGENTS.md) (title +
  message) each carry two, and one provider cannot serve both, so their parts
  keep per-part classes.
- **It renders `Animated.Text`.** Animated text styles work anywhere with no
  opt-in, at the cost of a Reanimated wrapper per text node. If a long list ever
  profiles badly, the escape hatch is to base the root on RN's `Text` and let app
  code write `<Animated.Text className={useTextClass()} style={…} />` — the
  cascade is on context, so that inherits correctly. Measure first.
- **OS font scaling is respected and capped.** `allowFontScaling` is left at
  React Native's default; `maxFontSizeMultiplier` defaults to
  `TEXT_MAX_FONT_SIZE_MULTIPLIER`. The cap exists for the fixed-height chrome —
  `h-button-*` and `h-navbar-row` cannot grow, so an uncapped multiplier clips a
  label rather than enlarging it. Both stay overridable per call site.
- **No `asChild`.** `Slot` throws on a non-element child and a `Text`'s child is
  usually a string, so it would be unusable in the shape people would reach for.
  There is also nothing to donate: `useTextClass()` hands the class over directly.
- **`TEXT_VARIANTS` is ordered — block presets first, largest first.** The tests
  read that order to assert the type scale descends, so a new block role goes in
  at its step rather than on the end; appended, it would pass a suite that is no
  longer checking anything. `TEXT_INLINE_VARIANTS` is the tail of the same list
  and carries no scale, so it has no such constraint.
