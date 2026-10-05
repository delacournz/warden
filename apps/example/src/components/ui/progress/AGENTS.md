# Progress

How far a task has got, or — indeterminate — that it is under way. Compound root
plus `Progress.Header`, `Progress.Label`, `Progress.Output`, `Progress.Track` and
`Progress.Fill`. An output, not a control: nothing here is pressed or dragged.

`import { Progress } from "@/components/ui/progress";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/progress` |
| `progress.tsx` | Root + the `Object.assign` compound surface, and the accessibility surface |
| `progress-header.tsx` | `Progress.Header`, the label-and-readout row |
| `progress-label.tsx` | `Progress.Label`, a `Text.Label` naming what is measured |
| `progress-output.tsx` | `Progress.Output`, the formatted value |
| `progress-track.tsx` | `Progress.Track` — the clip, and the width measurement |
| `progress-fill.tsx` | `Progress.Fill` — every animation the component runs |
| `progress.context.tsx` | `ProgressContext`, `useProgress()`, `useProgressContext()`, `useProgressPart()` |
| `progress.types.ts` | `ProgressRenderProps`, shared by the context and the readout |
| `progress.variants.ts` | Pure `tv()` slots + the ratio, geometry, formatting and accessibility resolvers |
| `progress.variants.test.ts` | |

## Design

- **Colours**: `default`, `primary`, `success`, `warning`, `destructive`, `info` —
  the slider's set, and a test pins the two lists equal so a bar and a slider in
  one form name a colour with the same word. **Sizes**: `sm`, `md`, `lg`, the
  track's thickness (`h-1`/`h-2`/`h-3`) and the header's type step.
- **The colour paints the fill, never the track.** An empty bar is the slider's
  groove, `bg-secondary`, at every colour. A test asserts the track's class does
  not move with `color`.
- **A bare `<Progress value={40} />` draws the bar.** The anatomy is written out
  when a label or readout is wanted, but a compound root with no default children
  renders an empty `View` — the failure the CLI's verify screen already hit once
  with `Slider`, and one no error reports.
- **No `isDisabled`, no `isInvalid`, no `Field`.** A progress bar reports; it
  does not accept input, so there is nothing to disable and no value to reject.
  `resolveProgressAxes` takes one argument and a test pins that, so a `Field`
  rung cannot be added by accident. A failed task is `color="destructive"`.

## Motion

- **The fill is a full-length bar slid under a clipping track.** Its position is
  a `translateX` of `(ratio − 1) × trackWidth` — a transform, composited on the UI
  thread with no layout pass. Animating `width` re-lays the bar out on every frame
  of every update. The track's `overflow-hidden rounded-full` is what makes the
  slide read as growth, and it keeps the leading end's round cap because that end
  is the fill's own, not a cut.
- **One timing per value, on the UI thread.** `useEffect` hands the new ratio to
  `withTiming` once (`PROGRESS_FILL_DURATION_MS`, ease-out); the frames that
  follow never touch React. An upload reporting ten times a second costs ten
  renders.
- **The first frame is at the value, not animated up from zero.** The shared
  value is seeded with the ratio, so a list of bars scrolling in does not
  replay a fill on every row that mounts.
- **Hidden until measured.** The track reports its width in `onLayout`; before
  that the fill is `opacity: 0`, because a bar positioned against a width of 0
  flashes at full length for one frame.
- **Indeterminate is a segment sweeping from wholly off-left to wholly
  off-right.** `indeterminateSegment` puts both ends of the loop outside the
  track, so the frame where `withRepeat` restarts is never on screen. A sweep
  that started at the track's left edge pops into view every pass.
- **Reduce motion swaps the sweep for a pulse, and does not stop it.** With the
  system setting on, the fill covers the whole track and breathes between
  `PROGRESS_PULSE.from` and `to`. Both animations opt out with
  `ReduceMotion.Never`: under the default policy a timing completes instantly and
  `withRepeat(-1)` spins a zero-length animation forever — a frozen bar, which
  reads as hung. `Spinner` makes the same call for the same reason. **Both layers
  opt out** — the timing *and* the `withRepeat`, which has a policy of its own:
  left at `System`, a reversing repeat never starts and a forward one stops after
  one pass. The pulse sat at full opacity on a simulator until the repeat's own
  argument was set. The pulse
  never reaches zero opacity, because a bar that disappears reads as finished.
- **The animated style returns the same keys in every mode** — `opacity`,
  `transform`, `width` — so flipping `isIndeterminate` never asks Reanimated to
  change a style's shape mid-animation.
- **Both effects clean up.** `cancelAnimation` on unmount and on every flip back
  to a value, or the repeat outlives the bar.

## Values and formatting

- **`progressRatio` clamps, and returns 0 for a degenerate range or a
  non-finite value.** An upload dividing by a total it has not learned yet
  produces `NaN`, and `NaN` written into a shared value freezes the fill for good.
- **The default readout is the share of the range** — `72%`, or `75%` for 18 of
  24. With `formatOptions` whose style is not `percent`, it formats the value
  itself (`$1,250`). A `percent` style still formats the *ratio*, merging the
  caller's other options, because `Intl` multiplies by a hundred and a value of 72
  would read `7,200%`.
- **`valueLabel` replaces the readout and the spoken text alike.** One string,
  so the screen and the screen reader cannot disagree.
- **`Progress.Output` takes a function child** handed `ProgressRenderProps`, for
  a readout the formatter cannot express — `18 of 24 seats`. While
  indeterminate the default readout renders nothing; a function still runs.

## Accessibility

- **The root is the one accessible element**, `accessibilityRole="progressbar"`,
  with the range and value in `accessibilityValue`. `resolveProgressAccessibility`
  decides the spoken text: the percentage over 0–100, `18 of 24` over any other
  range (formatted like the readout), or `valueLabel`. The count is what the
  screen is about; "seventy-five percent" makes the listener divide back.
- **`Progress.Label` stays visible to assistive technology** and becomes the
  element's name; `Progress.Output` is hidden (`accessibilityElementsHidden`,
  `importantForAccessibility="no-hide-descendants"`) because the root already
  speaks the value — left visible, it is read twice.
- **Indeterminate reports `busy: true` and no value.** A `now` of 0 is read out
  as "zero percent", a lie about work that is under way. A bar with no label
  needs an `accessibilityLabel`.

## Reuse

- **`Progress.Track` and `Progress.Fill` read only `ratio`, `isIndeterminate`,
  `color`, `size` and `trackSize` from context.** A meter is the same track and
  fill with a different root deciding the ratio and the colour, so a root that
  publishes `ProgressContextValue` through `ProgressProvider` reuses both parts
  as they stand. Keep anything a meter would not have — formatting, the
  indeterminate loop's *decision* — out of those two parts' reads.
