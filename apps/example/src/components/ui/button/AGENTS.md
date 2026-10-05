# Button

A pressable action, composed from parts rather than configured by flags —
compound root plus `Button.Label`, `Button.StartContent` and `Button.EndContent`,
and `Button.Group` for joining several into one run.
The reference implementation for the patterns in the package
[AGENTS.md](../../../AGENTS.md).

`import { Button } from "@/components/ui/button";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/button` |
| `button.tsx` | Root + the `Object.assign` compound surface |
| `button-label.tsx` | `Button.Label` |
| `button-start-content.tsx` | `Button.StartContent` |
| `button-end-content.tsx` | `Button.EndContent` |
| `button-group.tsx` | `Button.Group` + its `Object.assign` compound surface |
| `button-group-separator.tsx` | `Button.Group.Separator` |
| `button-group-text.tsx` | `Button.Group.Text` |
| `button.context.tsx` | `ButtonContext` and the two group contexts, with their hooks |
| `button.types.ts` | Prop types shared by two or more parts |
| `button.variants.ts` | Pure `tv()` slots, no RN imports |
| `button.variants.test.ts` | |

## Design

- **Variants**: `primary`, `secondary`, `tertiary`, `outline`, `ghost`,
  `destructive`, `destructive-soft`. **Sizes**: `sm`, `md`, `lg`, and the square
  `icon-sm`, `icon-md`, `icon-lg`.
- **Icons are composed, never passed as props.** Put an `Icon` in the children,
  before or after the label. The button wraps its subtree in an
  `IconDefaultsProvider` carrying `buttonVariants({ size }).icon()` and
  `BUTTON_FOREGROUND_TOKEN[variant]`, so a bare `<Icon icon={IconPlus} />`
  comes out the right size and colour with nothing said at the call site. An
  explicit `size` or `color` on the icon still wins. `Button.StartContent` /
  `Button.EndContent` remain for wrapping non-icon content.
- **The corner is a token on the size axis crossed with the group axis, and
  nothing else sets one.** A button standing alone names
  `rounded-button-{step}` — half its own height, so it is a capsule, and a
  circle at a square size. Keeping it out of the base and off every variant
  means exactly one corner *statement* reaches the root, so a caller's
  `className="rounded-lg"` has a single thing to beat and tailwind-merge is
  never picking between two. The shape is a default rather than a law: three
  numbers in `tokens.css` square the whole kit off without touching a
  component. Values above half the height are clamped by the renderer, which is
  why `tokens.test.ts` holds them under it.
- **A square footprint is a size, not a flag.** `icon-sm` / `icon-md` /
  `icon-lg` are `sm` / `md` / `lg` with the horizontal padding traded for a width
  off the same token. Padding and width are then mutually exclusive by
  construction rather than by rule, which is what let an `isIconOnly` axis and
  six compound variants reconciling it against `size` be deleted outright. It is
  also shadcn's spelling (rule 11), so `size="icon-md"` pastes across. Always
  pair one with an `accessibilityLabel`; there is no text for a screen reader to
  fall back on.
- **String children** are wrapped in a `Button.Label` automatically. React
  Native crashes on bare text outside a `<Text>`, so never render a raw string
  in a component that accepts free-form children without doing the same. Note
  that *consecutive* strings collapse into one label — `Row {i}` is a single
  piece of text, and wrapping each part separately would space them apart by
  the button's own `gap`.
- **A button is a [`Pressable`](../pressable/AGENTS.md).** `ButtonProps` extends
  `PressableProps`, so `feedback`, `haptic` and the rest are inherited rather
  than restated; only the default differs, `scale`. It carried a narrowed
  `ButtonFeedback` union for a while — that is gone, because a second definition
  of a prop the button does not change is a definition that can drift. **Do not
  add ripple, ink, glow or highlight overlays** — no wash layers on pressables
  in this library. That rule is about wash layers, not the opacity axis, which
  `fade` and `scale-fade` are welcome to use.
- **`isLoading` replaces the icon on its own side, it does not join it.** The
  spinner takes the place of the composed `Icon` at the edge `spinnerPlacement`
  names — the first child at `start`, the last at `end` — so the label does not
  shift when work begins and shift back when it ends. The swap costs no layout
  because both glyphs are drawn at the button's own `size-icon-*` token: the
  root publishes one class and the icon and the spinner both read it. **An icon
  on the other side is not taken.** A button with one leading icon and
  `spinnerPlacement="end"` keeps the icon and gains a spinner at the end; taking
  the only icon whichever side it sat on used to draw the spinner opposite the
  side that was asked for. With no icon at that edge the spinner is inserted, as
  it always was. Only a bare `Icon` is swapped; a `Button.StartContent` wraps
  content of unknown height, and replacing one could resize the button.
  `resolveSpinnerSwapIndex` is the pure decision and is unit-tested.
- **`isLoading`** composes a `Spinner` in and blocks presses. Placement is
  `spinnerPlacement`: `start` (default), `end`, or `only` — which drops the
  children and centres the spinner in the footprint the button already has,
  carrying the label onto `accessibilityLabel` so a screen reader still has a
  name to read. `only` never changes the footprint — a square is a `size`, and
  loading cannot reach one; use `size="icon-md"` when a square is what you want.
- **Loading is not disabled.** `isLoading` blocks the press and announces the
  button as *busy*, but keeps full contrast: the spinner already says the press
  landed, and dimming reads as "this control is unavailable". `isDimmedWhileLoading`
  opts into the faded treatment where a caller wants it.
- **A stretched button does not change width while loading**, because `only`
  keeps its footprint. In a *content-width* container — a `flex-row` — it still
  shrinks to the spinner, and that snap is un-animated on purpose: Pressable's
  `Animated.View` already runs a `useAnimatedStyle` on `opacity` and `transform`,
  and a native layout transition on the same view fights it for prop ownership.
  A caller who needs a stable width in a row pins it (`w-full`, `min-w-*`).
- **A definite width defeats `alignItems: stretch`.** A stretch-aligned child
  with a definite cross size resolves to cross-*start*, not centre — so any
  control that conditionally takes a fixed width inside a gap column jumps to
  the left edge unless it also sets `self-center`. This is what made an earlier
  `only` implementation collapse a full-width button into a small box flush
  left. Prefer not taking the width at all.

## Button.Group

Several controls joined into one run: `<Button.Group>` around the buttons, with
`Button.Group.Separator` for a rule between two of them and `Button.Group.Text`
for a chunk that says something rather than doing something. An
[`Input`](../input/AGENTS.md) joins the same way.

- **Position is computed in JavaScript, because React Native has no sibling
  selector.** shadcn/ui squares a web button group's inner corners with
  `[&>[data-slot]~[data-slot]]:rounded-l-none` and drops the seam border with
  `border-l-0`. Neither selector exists here, and no parent `View` can reach a
  child's style. So the root walks its children, works out each member's place
  with `resolveGroupPositions`, and publishes it through a per-child context the
  member reads. A provider is not a host component, so nothing is added to the
  layout — Yoga sees exactly the children the group's `View` already had.
- **A member wrapped in a context, never cloned with props.** `cloneElement`
  reaches only a *direct* child, so a member a caller wrapped in a `View` or
  produced from a helper would silently keep its round corners. Context reaches
  any depth, which is also what lets a control this package has never heard of
  join a run by reading `useButtonGroupItem()`.
- **A joined member replaces its corner; it never layers a squaring class over
  it.** This is the subtle one. Layering *renders* correctly — Uniwind
  arbitrates a className string per style property in token order, and React
  Native's corner cascade puts a per-corner radius above the uniform one — but
  tailwind-merge annihilates a side class the moment any all-corner class is
  emitted after it, and `tv` emits variants in declaration order. A surviving
  `rounded-button-md` on the size axis would therefore delete the squaring pair
  as soon as someone reordered two keys in `buttonVariants`, with nothing to see
  in the diff. `cn.test.ts` pins the asymmetry in both directions.
- **Horizontal squares on the logical axis; vertical squares on the physical
  one. Never mix them.** `rounded-s-*` / `rounded-e-*` compile to
  `border-start-start-radius` and friends, survive lightningcss, and flip under
  RTL — which is what a horizontal run wants. Tailwind's `rounded-t-*` /
  `rounded-b-*` are physical and need no flip. React Native resolves a physical
  corner *above* a logical one, so a stray `rounded-t-*` on a horizontal member
  would silently outrank the `rounded-s-*` beside it and round the wrong edge. A
  test asserts neither orientation emits the other's form.
- **The seam is a negative margin, not a dropped border.** Two adjacent
  `outline` members would otherwise draw a two-point seam. `-ms-px` / `-mt-px`
  pulls each member back over its neighbour so the two borders land as one
  hairline. `border-s-0` was the alternative and is wrong twice: the base
  reserves `border border-transparent` precisely so switching variant never
  resizes the box, and dropping a point would make one member narrower than the
  rest and shift its centred content half a point — and it would only be right
  for the variants that draw a visible border, which the group cannot know
  because a member may name its own. A margin moves the box and changes nothing
  about it, so it is emitted for every seamed member regardless of paint.
- **A separator takes no position and suppresses the seam after it.** It is a
  rule, not a segment, so the buttons either side of one are still the run's
  first and last and keep their rounded outer corners. And the member following
  it does not overlap: a one-point rule under a one-point overlap is an
  invisible rule. `resolveGroupPositions` and `resolveGroupSeams` are two walks
  rather than one because they ask different questions — "how many of us are
  there" and "what is immediately before me" — and both are pure, so the whole
  matrix is reachable from `bun test`.
- **Membership is a deny-list.** Anything that is not a separator is a member.
  Not `child.type === Button`, for two reasons: it lets a custom control join,
  and it means `button-group.tsx` never imports its own root for an identity
  check — which would close a cycle (package AGENTS.md rule 3).
- **A joined member fades rather than scaling.** `feedback` defaults to `scale`
  on a lone button, which pulls a member's edges in by a point and a half while
  its neighbours hold still — the seam the group exists to close tears open for
  the length of the press. `resolveButtonFeedback` runs the usual nearest-wins
  ladder (`own ?? group ?? default`) and only changes the last rung, so a caller
  still gets `scale` by asking for it on one button or on the whole group.
  `??` rather than `||`, so an explicit `none` is honoured instead of read as an
  absence. `pressedScale` still beats both — that is `resolvePressedState`'s
  documented contract and a second rule contradicting it would be worse than the
  tear.
- **The group owns the axes because it owns the shape.** `size` all but
  outright, and `variant`, `isDisabled` and `feedback` as defaults a member may
  override. Those three are published **raw**, so `undefined` means "the group
  said nothing" and one member can disable itself inside a group that did not.
  `Button`'s `variant` and `size` therefore come out of its destructure
  *undefaulted*; a default there would swallow the group before it was ever
  consulted.
- **A group owns a member's step, but not its shape.** Those are one axis now
  that a square footprint is a size rather than a flag, so resolving `size` to
  the group's value outright would make a square member impossible inside a run:
  the icon button ending a split button would silently grow a label's padding
  and lose its width. `resolveGroupedButtonSize` therefore takes the step from
  the group — controls of different heights do not join — and the shape from the
  member, falling back to the group's shape when the member names no size. An
  `icon-md` member of an `sm` group comes out `icon-sm`: square, and the same
  height as everything beside it. A control with no square form of its own reads
  `resolveButtonSizeStep` instead, which is exactly what a joined `Input` does.
- **The group paints nothing.** No background, no border, no disabled fade. A
  disabled group publishes `isDisabled` and each member fades itself; a group
  fading as well would compound the two down to a quarter opacity. It carries no
  `gap` either — a gap is the seam this component exists to close — and no
  `overflow-hidden`, which would square off the very corners the position
  compounds just rounded.
- **No `accessibilityRole` on the group.** Announcing a control with no action
  in front of every member helps nobody; the members are already buttons.
- **Horizontal groups are content-width** (`self-start`), because that is what a
  segmented control is. For a run that fills its parent, put `className="w-full"`
  on the group and `className="flex-1"` on each member — **and make sure the
  parent has a definite width**. Yoga resolves a percentage against the parent's
  content box, so `w-full` inside a container that is itself content-sized
  resolves to nothing and falls back to the content width: the group collapses
  onto its buttons and a `flex-1` field between them is squeezed to a few points.
  It looks like the group ignored `w-full`. It did not; there was no width to
  take a percentage of.
- **`Button.Group.Text` draws the button's own chrome**, not chrome of its own,
  which is what keeps its height, padding and corner identical to the buttons
  beside it — those come off one axis, and restating any of them here is how a
  row stops lining up three tokens later. It falls back to `secondary` rather
  than `primary` when nothing names a variant: a chunk that cannot be pressed
  should not wear the group's action paint. A group that *does* name a variant
  is followed, so an outline run reads as one piece.
