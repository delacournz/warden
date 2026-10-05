# Tabs

A row of tabs and the panels they switch between. Compound root plus `Tabs.List`,
`Tabs.ScrollView`, `Tabs.Indicator`, `Tabs.Trigger`, `Tabs.Label`,
`Tabs.Separator` and `Tabs.Content`.

`import { Tabs } from "@/components/ui/tabs";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/tabs` |
| `tabs.tsx` | Root — owns the order walk, the value flow and the pan |
| `tabs-list.tsx` | `Tabs.List` — the track, and the measurement registry |
| `tabs-scroll-view.tsx` | `Tabs.ScrollView` — the scroller and its UI-thread auto-scroll |
| `tabs-indicator.tsx` | `Tabs.Indicator`, the one sliding layer |
| `tabs-trigger.tsx` | `Tabs.Trigger` — a `Pressable`, and the frame the indicator reads |
| `tabs-label.tsx` | `Tabs.Label` |
| `tabs-separator.tsx` | `Tabs.Separator`, a `Separator` behind an animated opacity |
| `tabs-content.tsx` | `Tabs.Content`, one panel |
| `tabs-pager.tsx` | The clipped viewport and the translating row — internal |
| `tabs.context.tsx` | Five contexts, split by what changes, with their hooks |
| `tabs.types.ts` | Prop types shared by two or more parts |
| `tabs.variants.ts` | Pure `tv()` slots + the gesture and geometry worklets, no RN imports |
| `tabs.variants.test.ts` | |

## Design

- **Variants**: `primary` (a fully rounded capsule inside a muted track),
  `secondary` (an underline rule). **Sizes**: `sm`, `md`,
  `lg` — the trigger's floor and padding, the gap ladder, the label's `Text` step
  and the glyph step a composed `Icon` inherits, on one axis.

## Value flow and tab order

- **The whole component moves off one shared value**, `position`, a float index
  into the panels' order. A press springs it, a drag writes it directly, and the
  pager's translation, the indicator's frame and every separator's opacity are
  three readings of it. Two clocks is how a capsule ends up a frame behind the
  panel it is meant to be sitting on.
- **The panels are the order of record, and they alone must be direct children.**
  The root walks its own children for `Tabs.Content`, exactly as
  [`ListGroup`](../list-group/AGENTS.md) finds a hand-placed `Separator`, and
  their source order is what `position` indexes into. Triggers are **not**
  walked: each finds its place by looking its `value` up in that list, so it can
  sit behind a wrapper or come out of a `.map()`. Walking triggers instead breaks
  the first time anyone writes `<FilterTabs />` — the walk sees a component it
  does not recognise and silently drops tabs. A bar with no panels at all is a
  real shape (a filter row driving a list elsewhere) and falls back to trigger
  registration, which is one commit late and therefore never preferred when
  panels exist.
- **The one mistake source cannot catch is caught in the measurements.** Triggers
  written in a different order from the panels put the indicator on the wrong
  tab, with nothing in the source to point at; `isTriggerOrderConsistent` checks
  the measured `x` values ascend and the list warns by name in development. Every
  trigger reporting an `x` of 0 catches the other shape — a trigger wrapped in a
  `View`, measuring itself against the wrapper rather than the row.
- **`isSwipeable={false}` is one `.enabled(false)` on the pan and nothing else.**
  Every panel mounts either way. Gating mounting on it would make one boolean
  change both the gesture and the mounting model, and the two are not the same
  setting — you cannot drag to a panel that is not there. Lazy mounting is the
  caller's, per panel, through `Tabs.Content`'s function children. There is no
  `isLazy`, because "lazy" is not one thing: a form wants to stay mounted, a
  video wants to stop, and a report wants never to have been built.
- **The value flow has exactly three writers and one repair.** The pan's
  `onUpdate`, the pan's `onFinalize`, and a reconcile effect; a JS-side ref records
  where the last of them aimed. `resolveReconcileMode` decides between `none`,
  `spring` and `jump` — and `jump` is the case a float index alone cannot see: a
  tab inserted before the active one moves its index without changing the
  selection, and springing there would animate an edit the user did not make. A
  reducer bump rides alongside every commit for
  [`Switch`](../switch/AGENTS.md)'s reason: a controlled parent that rejects a
  change re-renders nothing, so a reconcile waiting on the parent's commit would
  never run.
- **The reconcile effect registers no cleanup, and that is load-bearing.**
  [`Checkbox`](../checkbox/AGENTS.md) and [`Switch`](../switch/AGENTS.md) both end
  their spring effects with `cancelAnimation`, and both can afford to: their
  effect starts a fresh animation on *every* run, so a cleanup cancelling the
  previous one always has a replacement behind it. This one does not — its `none`
  branch returns early — and the commit that runs the cleanup is the very one the
  gesture just caused. A swipe would start its settle spring, `commitFromPan`
  would re-render, the previous run's cleanup would cancel that spring, and the
  new run would take `none` and restart nothing: the pager froze part way between
  two panels, intermittently, according to whether the commit beat the spring.
  Before copying a `cancelAnimation` cleanup into a new component, check that
  every path through the effect starts an animation. An in-flight spring on an
  unmounted component is harmless — the shared value goes with it.
- **`onValueChange` fires once, from `onFinalize`, before the spring finishes.** The
  trigger highlights the moment the finger lifts rather than 300ms later.
  Driving it off `position` crossing a midpoint would fire it several times per
  drag and re-render every panel while the finger was still down.
- **An accepted swipe keeps its momentum.** `commitFromPan` records the target
  *before* it sets the state, so the reconcile sees no divergence and leaves the
  gesture's own velocity-seeded spring alone. Rejecting the change is what makes
  it spring back.

## The measured indicator

- **The measurement registry is a JS map published as one shared value, coalesced
  to one write per tick.** One value holding three pre-built arrays, not three
  values holding one each: `interpolate` throws when its ranges differ in length.
  Without the `queueMicrotask` coalescing an eight-tab bar writes eight times in
  one layout pass and the UI thread can render between two of them, showing an
  indicator built from four new positions and four old ones. A re-layout
  reporting identical numbers is dropped, because reassigning a shared value
  invalidates every worklet reading it. `resolveMeasurementTracks` is
  all-or-nothing — a half-measured bar would collapse the indicator to nothing
  every time `position` crossed the missing tab.
- **The indicator animates `width` and `translateX`, never `scaleX`.** A scale is
  cheaper and wrong three times over: `rounded-full` stretches to an ellipse at
  the 2.3× a short tab to a long one asks for, a border thickens on two edges
  only, and any children a caller passes are squashed with it — which no
  counter-scale can fix across an arbitrary subtree. The cost is bounded because
  the indicator is absolutely positioned: its size change never dirties a
  sibling, so the row's layout stays settled.
  [`Checkbox`](../checkbox/AGENTS.md) already animates a width every toggle.

## The pan gesture and the pager

- **The pan claims sideways and gives up vertical**, `activeOffsetX` under
  `failOffsetY` so a diagonal drag resolves to exactly one of them. That is the
  whole mechanism, and it is what lets a pager live inside
  [`Screen.ScrollArea`](../screen/AGENTS.md). `blocksExternalGesture` is **not**
  the alternative — `Screen.ScrollArea` renders React Native's own `ScrollView`,
  which has no handler tag to resolve, so the call is dropped without an error.
  [`Slider.Track`](../slider/AGENTS.md) found that first, and reaches the opposite
  conclusion for the opposite reason: a slider must claim even a stationary tap,
  so it takes `minDistance(0)` and no axis offsets at all.
- **The settle lives in `onFinalize`, and the spring is cancelled in `onStart`.**
  Both halves were wrong once and the symptom was the same: a pager frozen half
  way between two panels. `onBegin` fires for *every* touch the pager sees — a
  tap on a panel, the first moment of a vertical scroll — and most of those go on
  to FAIL against `failOffsetY`. Cancelling the settle spring there killed an
  animation for a gesture that never became a drag, and because `onEnd` only runs
  for a pan that actually activated, nothing restarted it. `onFinalize` is the
  one callback that runs on every path out of a gesture, END, FAILED and
  CANCELLED alike, from any state — the rule
  [`Slider.Track`](../slider/AGENTS.md) already states — so it owns the settle,
  guarded by a flag so a touch that never activated cannot retarget a spring it
  never disturbed. Reproduce the old bug by swiping and then scrolling the page
  before the spring has finished.
- **The drag's origin is back-computed at activation, not captured at
  touch-down.** `translationX` counts from touch-down but the pan does not
  activate until the finger has crossed `activateX`, so an origin taken at
  activation would apply that travel twice and jump the pager on the first frame.
  `resolvePanOrigin` returns the value that makes `resolvePanPosition` yield the
  pager's current position for the translation so far, which is also what lets a
  mid-spring grab pick up exactly where the capsule is.
- **A horizontal scrollable *inside* a panel is the caller's to settle**, because
  only they know which should win. The pager publishes its pan on
  `useTabsMotion()`, and the caller writes
  `Gesture.Native().blocksExternalGesture(panGesture)`. A hook rather than a
  prop, the trade `useScreenFooterKeyboardClearance` already makes.

## The auto-scrolling bar

- **The bar's auto-scroll runs on the UI thread**, through the package's only
  `useAnimatedRef` and `scrollTo`, and it interpolates the *fractional* trigger
  geometry — so the row tracks a finger through a drag rather than jumping once
  the swipe settles. A hand-scroll always wins, and the flag saying so clears on
  **momentum end** rather than on the finger lifting: retargeting into a coast is
  a tug-of-war the user feels as the bar snapping backwards mid-flick.
  `resolveScrollOffset` clamps at both ends, and `none` returns the current
  offset rather than 0 — "leave the bar alone", not "send it home".

## Separators

- **A separator fades only while the pager is crossing it.** At rest a bar shows
  every rule it has; a drag dips the one it travels over and brings it back. The
  first shape hid every rule *flanking* the active tab, which is a different
  thing and reads badly — on a three-tab bar it leaves exactly one rule visible
  over on the far side, and the set changed on every tab change so the bar never
  looked still. Measuring from the gap's own midpoint makes the fade mean one
  thing: the capsule is on top of this rule right now.
- **A faded separator still takes its width**, so the row never reflows as the
  fade runs. That also means separators make a bar wider — enough to tip a row
  that only just fits into one that scrolls, at which point `scrollAlign` starts
  moving it for no reason a user can see. Reach for `Tabs.ScrollView` when the
  tabs genuinely do not fit, not by default.

## Triggers and labels

- **A render prop must not change a trigger's size.** A trigger's width *is* the
  indicator's geometry, so content that appears only on selection — a badge, a
  count — re-measures the row and shifts the whole bar every time the tab
  changes. Swap a treatment rather than adding or removing content: the
  playground's composition demo switches a `Badge`'s `variant` and keeps it
  mounted throughout.
- **The label's colour crossfades; it is a style, not a class.** It interpolates
  between the two values `TABS_FOREGROUND_TOKEN` names, off the same `position`
  the capsule and the panels read — so it fades *with* the capsule arriving
  rather than flipping the moment a midpoint is crossed. One function covers a
  finger dragging, a flick and a plain tap without knowing which is happening,
  because all three write that one value.
  [`Checkbox`](../checkbox/AGENTS.md)'s animated border makes the same trade for
  the same reason: a colour that travels cannot be a class.
  `resolveTabSelectedness` is the ramp, and it is pure, so `bun test` reaches it.
- **The `label` slot therefore names no colour at all, and a test enforces that.**
  Two sources for one colour is how a class and a style end up disagreeing for a
  frame on every commit. `TABS_FOREGROUND_TOKEN` is the whole matrix now, swept
  for distinctness and asserted present in both themes — the decision stayed
  reachable from `bun test`, it just moved from class strings to token names.
- **`visualIndex` survives for the things that cannot fade.** A composed `Icon`
  takes its colour as a resolved *value* rather than a style, so it has no way to
  be half way between two; it swaps at the midpoint, with a hysteresis band
  because a finger held exactly there would otherwise flip it every frame and
  each flip is a commit. That leaves a visible mismatch on a trigger holding both
  a glyph and a label — the glyph steps while the text fades. Fixing it means
  crossfading two stacked copies of the trigger's content, which renders a
  caller's children twice; not worth it until a design needs it.
- **The trigger's `TextClassProvider` carries no colour either**, following the
  slot. A bare `<Text>` composed into a trigger takes the page colour; reach for
  `Tabs.Label` when it should read as part of the tab.
- **The axis ladder is `own ?? root ?? default`,
  [`Checkbox`](../checkbox/AGENTS.md)'s and not
  [`Radio.Group`](../radio/AGENTS.md)'s.** A radio group puts itself first because
  escaping a disabled form group is a bug; a tab bar's disabled state is
  transient chrome and the per-trigger case is the common one, so it has to
  survive the bar-wide one being set. There is no `Field` rung and no
  `isInvalid`: tabs are navigation, nothing here has a value that can be wrong,
  and a `Field` around a `Tabs` would grey out a navigation bar from a form's
  state.
- **The disabled fade lands on the label, never on the trigger.** The `trigger`
  slot is worn by [`Pressable`](../pressable/AGENTS.md)'s own `Animated.View`,
  which now multiplies a className's opacity into its press rather than
  overwriting it — but the label already fades, and a fade on the trigger as
  well would compound the two to a quarter. [`Radio`](../radio/AGENTS.md)'s
  arrangement.
- **Selection changes the label's colour and nothing else.** A weight change
  would re-measure the label, which moves the frame the indicator is sitting on,
  on every tap. A test asserts the two class sets differ by exactly one `text-*`.

## Sizing and surface

- **No `--spacing-tabs-*`, and that is a decision.** A tab lines up against no
  chrome that forces a height, so the trigger takes `min-h-*` from Tailwind's own
  scale — a floor, so a large accessibility step grows the row instead of
  clipping the label. [`Badge`](../badge/AGENTS.md)'s "a size is padding, never a
  height", and [`Checkbox`](../checkbox/AGENTS.md)'s argument against minting a
  private scale.
- **The track and the capsule are both `rounded-full`, and there is no radius
  arithmetic at all.** A pill inside a pill is concentric at *any* padding, which
  is the property `resolveCheckboxFillRadius` has to subtract a border width to get
  for a rounded rectangle. The first shape of this component did subtract a
  padding from a named `rounded-*` step per size — three maps to keep in step,
  and a rectangle that still read as boxy against its own track. Do not
  reintroduce them.
- **The capsule is painted on `elevated`, a token minted for it.** The surface
  has to sit *above* `muted` in both themes and nothing in the neutral ramp did:
  `card` is the same white as `background` in light and **darker** than `muted`
  in dark, so a capsule painted on it reads as raised in one theme and sunken in
  the other. The selected label takes `elevated-foreground` accordingly — rule 11,
  applied to the surface the label is actually drawn on.
- **There is no third variant.** An accent-filled capsule with no track was
  tried and dropped: next to `primary` it differed only by its fill and the
  absence of a track, which is a variant a caller picks by accident rather than
  on purpose. A caller who wants one writes `className` on `Tabs.Indicator`,
  and takes the label's colour with it.

## Accessibility

- **Reduce motion takes the default `System` policy**,
  [`Checkbox`](../checkbox/AGENTS.md)'s call rather than
  [`Spinner`](../spinner/AGENTS.md)'s. The state change is the point and the
  travel is decoration. One wrinkle worth writing down: **the drag itself is
  unaffected and must be** — `onUpdate` writes `position.value` directly, with no
  `withSpring` to shorten. A direct manipulation is the user's own hand, not
  motion played at them; only the release settle degrades.

## Deliberate omissions

- **There is no `Tabs.ListBackground` and no `background` prop.**
  [`Screen.Navbar.Background`](../screen/AGENTS.md) exists because that part
  overlays content and its backing has to travel with the keyboard translation. A
  tab track is a static box in the flow, `bg-muted` on the `list` slot is the
  whole feature, and `variant` already says whether there is one.
- **There is no public pager, no `orientation`, and no router prop.** The root
  wraps its own panels the way [`ListGroup`](../list-group/AGENTS.md) inserts its
  own dividers; a vertical tab bar is a sidebar, a different component whose
  measurements are not in x; and this library takes no navigation dependency, so
  `onValueChange` is where an app calls its router —
  [`Screen.Navbar.BackButton`](../screen/AGENTS.md)'s trade.
- **No `hitSlop`, and no wash layers.** A trigger is already a wide row, and slop
  on top of it would overlap the trigger beside it and make a tap between two
  ambiguous — [`Checkbox`](../checkbox/AGENTS.md)'s rule. The capsule sliding
  under the label is the feedback; `feedback="fade"` on top of it is the press.
