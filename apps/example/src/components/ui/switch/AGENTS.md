# Switch

A binary preference, flipped by a tap or by dragging its thumb. Compound root
plus `Switch.Thumb`, `Switch.StartContent` and `Switch.EndContent`. It inherits
almost every structural decision from [Slider](../slider/AGENTS.md), which is the
section to read first — what follows is only where a switch differs.

`import { Switch } from "@/components/ui/switch";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/switch` |
| `switch.tsx` | Root — owns the pan, the state and the track |
| `switch-thumb.tsx` | `Switch.Thumb`, the knob and its one animated style |
| `switch-content.tsx` | The shared body behind both content layers — internal |
| `switch-start-content.tsx` | `Switch.StartContent` |
| `switch-end-content.tsx` | `Switch.EndContent` |
| `switch.context.tsx` | `SwitchContext`, `useSwitch()`, `useSwitchContext()`, `useSwitchPart()` |
| `switch.types.ts` | Prop types shared by two or more parts |
| `switch.variants.ts` | Pure `tv()` slots + the release worklet, no RN imports |
| `switch.variants.test.ts` | |

## Design

- **Colours**: `default`, `primary`, `success`, `warning`, `destructive`, `info` —
  Badge's, Checkbox's and Slider's set. **Sizes**: `sm`, `md`, `lg`. There is no
  `variant` axis: a switch has one shape, and a second way to paint it would be
  a second thing to keep in step with the checkbox beside it.

## Gesture

- **The root is not a `Pressable`**, for `Slider`'s three reasons: its
  `Gesture.Tap()` would fire `onPress` on every toggle, its root `Animated.View`
  already owns `transform` — which is exactly what a thumb's position is — and a
  thumb inside its own pressable would nest a descendant recogniser in the
  root's. `HapticFeedback` and `playHaptic` are imported from `pressable.tsx`,
  which is what that export is for.
- **One `Gesture.Pan()` serves the tap and the drag, and there is no `Tap` to
  race it.** A release whose finger barely moved *is* the tap, which
  `resolveSwitchRelease` decides along with everything else: tap slop first, then
  a flick's velocity, then the position. Two recognisers would have to negotiate
  which one owned a press that turned into a drag, and the negotiation is the
  bug — this way there is nothing to arbitrate.
- **`distance` is the larger of the two axes, not the along-track
  translation.** A vertical swipe that began on the switch moves nothing
  horizontally, so reading only that axis would call every attempt to scroll past
  the control a tap and toggle it. Reading both means such a swipe is movement
  with no travel, which settles back to the state it started in — the switch is
  left alone.
- **The value is settled in `onFinalize`, and only there.** Unlike a slider there
  is nothing to write on `onBegin`: a switch has no position to move a handle to,
  only a state to end up in. `onFinalize` is still the callback because it is the
  one that fires on every path, the never-activated one included — which is
  exactly the path a stationary tap takes.
- **`minDistance(0)` and `shouldCancelWhenOutside(false)`**, for the reasons
  [Slider](../slider/AGENTS.md) sets out. The cost is the same one: a drag that
  starts on the switch is the switch's, so you cannot scroll a list by putting
  your finger on one.

## Geometry

- **The knob is a rounded rectangle lying on its side, not a disc**, and it is
  the reason the thumb stopped reading `--spacing-icon-*`. That scale is where a
  *glyph* belongs; a knob is the body of the control rather than a mark drawn on
  it — the move `Slider`'s handle already made, and why `Checkbox` still reads
  that scale for a square that really is a glyph in a box. No
  `--spacing-switch-*` was minted either way; the thumb is plain spacing steps.
- **Three relationships hold at every size, and the tests pin each rather than
  the points.** The knob's width is the track's height; its height is that less
  twice `SWITCH_THUMB_INSET`; and because both are `rounded-full`, the two
  capsules come out **concentric** — each radius is half its own height, so the
  difference is exactly that inset. It is the subtraction `Checkbox`'s fill makes
  against its border, arrived at by construction rather than by a number.
- **One inset, all four sides, and only two of them are written down.**
  Horizontally it is a class the travel maths subtracts twice; vertically it is
  never written at all, because the track is `justify-center` and an absolutely
  positioned child with no vertical inset is centred by its parent — `Slider`'s
  rule, where the track centres the thumb and the thumb carries no offset of its
  own. On that axis the constant is a relationship a test pins, not a value
  anything reads.
- **A content layer is as wide as the travel, not as wide as the knob.** It
  occupies exactly the space the knob vacates at its own end, which is what the
  travel *is*. Size it like the knob and the far layer reaches under a knob drawn
  on top of it, and its text is clipped — visible only at the size where the text
  is longest, which is the last place anyone looks.
- **The knob draws no border and no shadow.** A border is a second line where
  there is already a boundary, and against a saturated track it reads as a dark
  ring rather than as definition; `Slider`'s handle dropped its own for the same
  reason. Contrast at rest comes from the track instead, which is why
  `SWITCH_TRACK_REST_TOKEN` is `input` — the chrome a field's own box wears, a
  step darker than the page in light and a step lighter in dark, so a knob
  painted the page's own colour reads against it at either end of the theme.
- **The track and its touch padding ride in the same size cell**, summing to 44pt
  at every size, and the test asserts the sum rather than the parts — `Slider`'s
  rule, and the trap it names: split them across two variants and a shorter track
  silently shrinks the target.

## Colour

- **Every colour on the control is interpolated, so the `tv()` describes almost
  none of it.** The track, the thumb and both content layers fade between two
  token *values* off the one `progress`, and a colour being interpolated cannot
  be a class — `Checkbox`'s border, four times over. The slot set keeps
  `bg-secondary` and `bg-background` as the resting appearance those styles start
  from and names no colour anywhere else; the maps are the single source. There
  is deliberately **no `color` axis in the `tv()`** — a `bg-*` per colour there
  would be a second source for one surface, which is how a class and a style end
  up disagreeing for a frame on every toggle.
- **The thumb takes the `-foreground` of the track it is travelling on**, so a
  pale knob is never left unreadable on `warning`. `default` is the exception the
  theme forces: there is no `--foreground-foreground`, and `background` is
  what content drawn on the page's ink actually is. A test pins the whole map
  against the track's.
- **`Switch.StartContent` and `.EndContent` crossfade themselves.** Start sits at
  the leading edge, which the knob vacates as the switch turns **on**, so it fades
  in with `progress`; end is the mirror. That is the whole reason both can be
  written once with no `isSelected &&` at the call site — the knob reads as
  uncovering the other end rather than sliding over content that was always
  there. Each layer is exactly the thumb's footprint at its own end, so a glyph is
  centred on the space the knob will vacate rather than beside it, and each
  publishes an `IconDefaultsProvider` and a `TextClassProvider` for the surface it
  sits on: the coloured track for start, the resting one for end.
- **A glyph's colour is a token and a `Text`'s is a class**, so
  `SWITCH_CONTENT_TEXT_CLASS` exists beside `SWITCH_THUMB_TOKEN` rather than being
  derived from it — Tailwind's scanner is static, so a runtime `text-${token}` is
  never compiled and would silently draw nothing. A test pins every entry against
  the token it must agree with.

## Layering and motion

- **The thumb is drawn last however the children were written.** Every part is
  absolutely positioned and React Native paints later siblings on top, so a
  `Switch.Thumb` written first — which is the order the anatomy reads best in —
  would slide *under* the content layers. The root reorders rather than leaving a
  gotcha in the API, and composes one in when the children hold none, so
  `<Switch />` is already a complete control.
- **The track scales on press, and the thumb does not** — the reverse of
  `Slider`, which grows its handle. The track clips, so a scaled knob would be
  cut off by its own capsule: a bite taken out of the knob rather than an
  acknowledgement of the press. The outermost node is the one thing nothing can
  crop, so that is where the feedback lives, on `Pressable`'s own `PRESS_SPRING`
  so a switch and a button answer a touch identically.
- **The thumb's own spring is critically damped**, where every other spring in
  this package overshoots a little. A wider knob travels a shorter distance
  inside a track that clips it, so an overshoot has nowhere to go — it would
  visibly squash against the end of its own capsule on every toggle. A test pins
  the damping ratio at or above one, and below the point where it crawls.
- **The colours interpolate off `progress`, not off a timing of their own.** The
  track therefore colours *with the finger* through a drag rather than snapping
  when it is let go, and there is no second clock for the position to drift
  from — the reason all four animated properties read one shared value.
- **The colour and the press scale are two entries in one `useAnimatedStyle`,
  never two calls.** Two animated styles on one view fight for the same props and
  the later one silently wins, so the press would land on a track that never
  scaled — `Radio.Indicator`'s rule, arrived at from the other side.
- **The haptic fires at the commit, never at the grab.** A slider ticks on grab
  because the grab already moves the value; a switch dragged half way and released
  back has changed nothing, and one that buzzed for it would be reporting a state
  change that did not happen. Default `haptic="selection"`, matching `Checkbox`.
- **`settledDrags` and the `isDragging` ref are `Slider`'s, verbatim in shape.**
  A controlled parent that rejects a dragged value leaves the state unchanged, so
  without a token that moves on every release the sync effect has nothing to
  re-run on and the thumb stays where the finger let go. The playground's
  `/switch` has a switch that rejects every change, so the spring-back is on
  screen rather than merely asserted.
- **Reduce motion is left at Reanimated's default `System`**, with `Radio` and
  `Checkbox` and against `Spinner`. The state is carried by the thumb's
  *position*, so snapping straight to it is the right degradation.

## Accessibility and API

- **The accessibility surface is written out, because there is no `Pressable` to
  inherit it from.** `accessibilityRole="switch"` and a checked state announce it;
  `onAccessibilityTap` and an `activate` entry in `accessibilityActions` are what
  actually flip it, on iOS and Android respectively. Without them the switch would
  announce its state and offer no way to change it — the same gap
  `Slider.Thumb`'s `adjustable` actions close.
- **The root is marked `accessible`, and that one word is load-bearing.** Without
  it the view is not an accessibility element on iOS at all, so the role and the
  checked state written beside it never reach VoiceOver. It also merges the track
  and its layers into the single element a control should be.
- **There is no `Switch.Label` and no `Switch.Group`.** The track is a fixed pill
  and a label cannot sit inside it, so the name is a `Field.Label` or a
  `ListGroup.ItemTitle` a row away — and unlike `Slider`, the switch **does**
  register `field.registerPress`, because a row-wide press means exactly what a
  tap on the pill means. A switch is a binary preference, not one of a set, so
  there is nothing for a group to own; the axis ladder is two rungs, the switch's
  own props then an enclosing `Field`.
- **A part is recognised by its `displayName`, never by reference alone.** The
  root composes a `Switch.Thumb` in when the children hold none, which means it
  has to *ask* whether a child is one — and `child.type === SwitchThumb` is not a
  safe way to ask. This package ships raw `.tsx` for the consuming app to
  compile, so React Compiler rewrites the binding on the way through, and Metro
  can serve two instances of one module through a workspace symlink; either
  leaves an element whose `type` is a different object standing for the same
  component. The failure is silent and nearly invisible: detection returns false,
  a second knob is composed on top of the caller's, and because the two are the
  same size and colour the only symptom is that **anything inside the caller's
  knob disappears**. `displayName` survives all of it — rule 12 requires one and
  `display-name.test.ts` enforces that they are present and unique — so that is
  what `isSwitchThumbElement` asks for, with reference equality kept only as the
  fast path.

  **[`Radio`](../radio/AGENTS.md) and `ListGroup` still ask the unsafe question**
  (`radio.tsx`'s indicator detection, and the divider and icon-swap walks
  elsewhere). Nobody has reported it because their duplicates overlap invisibly
  rather than hiding content — a second ring exactly behind the first. Worth
  fixing the next time one of them is touched.
- **RTL is not handled.** The thumb travels on `translateX`, which does not flip,
  and nothing else in this package handles it yet. Stated here rather than
  half-solved.
