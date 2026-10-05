# Steps

A stepper for a multi-step flow. Compound root plus `Steps.Item`, `Steps.Indicator`,
`Steps.Title`, `Steps.Description` and `Steps.Panel`; the connectors between steps are
internal and drawn by the items themselves.

`import { Steps } from "@/components/ui/steps";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/steps` |
| `steps.tsx` | Root — the value, the item count, and the `Object.assign` |
| `steps-item.tsx` | `Steps.Item` — the outer box, the trigger (a `Pressable` or a `View`), and `splitChildren` |
| `steps-track.tsx` | The track `[half] [circle] [half]`, and the rail beside a vertical panel — internal |
| `steps-panel.tsx` | `Steps.Panel` — content outside the tap target |
| `steps-indicator.tsx` | `Steps.Indicator` — the circle and its number, check, cross or spinner |
| `steps-title.tsx` | `Steps.Title` |
| `steps-description.tsx` | `Steps.Description` |
| `steps-connector.tsx` | One half of the line between two steps — internal |
| `steps.context.tsx` | The stepper's and the step's contexts, with their hooks |
| `steps.variants.ts` | Pure `tv()` slots + every resolver, no RN imports |
| `steps.variants.test.ts` | |

## Design

- **Variants**: `primary` (a completed step is solid, the current one a ring, the
  steps ahead hollow) and `secondary` (every indicator filled — completed soft,
  current solid, upcoming muted). **Sizes**: `sm`, `md`, `lg` — the circle's edge
  (24/32/40), the number's type step, the glyph's icon step, the title's `Text`
  step and the gaps, on one axis. **Orientations**: `horizontal` (titles centred
  under the circles, equal-width columns) and `vertical` (titles beside, the line
  running down).
- **Three statuses, off one number.** `resolveStepStatus` reads the step's index
  against the zero-based `value`: before it `completed`, at it `current`, after it
  `upcoming`. A step's own `completed` overrides that — `true` wins everywhere
  (the last step of a finished flow), `false` un-completes a passed step (a
  skipped optional one) but never demotes the current step, which would leave a
  stepper with nowhere the user is. `isCurrent` is kept beside the status for the
  same reason: a completed current step is still where the user is, and it still
  announces `selected`.
- **Invalid and loading are flags, not statuses.** A step can be completed *and*
  invalid (the payment failed on review), or current *and* loading. Folding them
  into the status would make the status a list of every pair.
  `resolveIndicatorGlyph` ranks what the circle draws: spinner over cross over
  check over number — loading outranks invalid because a failed step being
  retried is retrying.

## The connectors are laid out, not measured

- **The root counts its items and each item draws its own halves.** A horizontal
  item is an equal `flex-1` column whose track is `[half] [circle] [half]`; the
  line between two steps is one item's right half meeting the next item's left
  half at the column boundary. The outer halves of the first and last steps are
  transparent spacers, so every circle stays centred. A vertical item's track is
  `[circle] [line]`, the line `flex-1` down whatever height the content gives it,
  and the last step draws none. `resolveStepConnectors` is that whole decision.
  Nothing calls `onLayout`, so a title that wraps to three lines moves nothing a
  frame late — the failure a measured connector has on every first paint.
- **Both halves of one line fill off the value, never off a step's status.**
  `isConnectorComplete(step, value)` is `step < value`. Each half lives in a
  different item and can see only its own step's `completed` override, so a line
  coloured by status could be half filled. The value is the one thing both ends
  agree on.
- **The halves are square-ended.** Rounded ends meeting at the column boundary
  pinch a two-point line visibly at every joint.
- **Counting walks the direct children**, the way [`Tabs`](../tabs/AGENTS.md)
  walks its panels. A `.map()` is flattened by `Children.toArray` and counts; an
  item behind a wrapper component does not, and the root warns in development.
  With no count every item looks like the last and no line is drawn, which is the
  visible failure the warning names. An item also warns when its `step` falls
  outside the count — the usual cause is one-based indices.
- **A vertical title is padded down to sit level with its circle** — by half the
  circle's edge less the title's line height. It is the one number derived from
  another, and `steps.variants.test.ts` recomputes it from the slot classes, so a
  retuned circle or title step fails the suite instead of drifting half a line.

## Interaction

- **Read-only is inferred from the props React already has.** A controlled
  `value` with no `onValueChange` cannot move — a press would be thrown away —
  so the steps render as plain `View`s and are not announced as buttons.
  `isReadOnly` states it outright either way. `resolveStepsReadOnly` is the rule.
- **`resolveStepInteraction` returns `static`, `pressable` or `blocked`.**
  Blocked is still a `Pressable`, announced disabled: the step is disabled,
  loading, or ahead of the value under `isLinear`, where the flow's own Continue
  button is the only way forward and the steps behind stay open for going back.
  A loading step is passed to `Pressable` as `busy` rather than `disabled`, so it
  is announced busy, not dimmed.
- **Re-pressing the current step does not call `onValueChange`** —
  `shouldEmitStep`, the rule `Radio.Group` keeps.
- **The fade lands on the circle and the content, never on the trigger.** The
  trigger is `Pressable`'s own `Animated.View`, whose animated style writes `opacity`
  every frame and silently overwrites an `opacity-50` class — see
  [`Radio`](../radio/AGENTS.md). A root `isDisabled` wins over a step's own, the
  radio group's ladder.

## Accessibility

- **One element per step.** The trigger is `accessible`, so the circle, title and
  description merge into one stop. Its name is the title (the text it holds) and
  its `accessibilityValue.text` is `resolveStepAccessibilityValue` — "Step 2 of 3,
  completed", with ", has an error" and ", loading" appended. VoiceOver reads it
  as "Payment, Step 2 of 3, completed". The current step is `selected`.
- **The number does not scale with the OS text size.** The circle is a fixed
  edge, so a scaled numeral would spill out of it, and the position it shows is
  already in the accessibility value. The title and description scale as usual.
- **The connectors are hidden from assistive technology**, like `Separator` —
  they restate the status every step already announces.

## Colour

- **The number is a `Text` and the glyphs are SVG, and one test holds them
  together.** The number takes its colour as a class from the `indicatorLabel`
  slot (rule 1); the check, cross and spinner take theirs as a token through one
  `IconDefaultsProvider`. `resolveIndicatorForeground` names the token and the
  suite asserts, for every cell, that the slot emits `text-<that token>` and that
  `theme.css` declares it — a drift would be a white numeral beside a black check.
- **Every colour cell is a compound, invalid last.** `tv` emits compounds after
  plain variants, so a plain `isInvalid` branch would lose to the status cells —
  `radioVariants`' reason.
- **The title follows the step; the description does not.** Upcoming titles are
  muted, an invalid title is destructive. The description keeps `Text.Caption`'s
  muted colour in every state: the circle and the title already say where the step
  stands.
- **The check and cross land with a short `ZoomIn`**, keyed by glyph so a change
  of glyph replays it. Reduce motion is left at Reanimated's `System`, which snaps
  it in — the state is the glyph's presence, not its motion.

## The panel

- **`Steps.Panel` exists because the trigger is one accessibility element.** A
  form written inside the trigger was unreachable: `accessible` merges every
  descendant into one VoiceOver stop, so its text field and its Continue button
  could not be focused, and its button's tap gesture sat inside the step's own.
  The item therefore splits its children — the indicator into the track, a panel
  after the trigger, everything else into the text column — and a panel's
  controls are ordinary elements that never move the stepper.
- **A vertical panel sits beside a rail as wide as the circle**, which carries the
  trailing line on past it, so the panel reads as part of its step and the line
  still reaches the next circle. The gap before the next step moves from under
  the title to under the panel; the suite pins both halves of that move.
- **There is no "only while current".** A finished step's summary is as common a
  panel as the current step's form, so the caller gates it on `value`.
- **`className` styles the item's outer box; every other prop reaches the
  trigger.** `testID`, `onPress`, `haptic` and the accessibility props all belong
  to the thing that is pressed and announced.

## What it does not do

- **No `Steps.Separator`.** The connectors are derived from the count; exposing
  them would reintroduce the dangling-line failure the count exists to prevent.
