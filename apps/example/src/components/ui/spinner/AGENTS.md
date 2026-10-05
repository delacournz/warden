# Spinner

An animated loading indicator. Compound root plus `Spinner.Content`, the part
that rotates.

`import { Spinner } from "@/components/ui/spinner";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/spinner` |
| `spinner.tsx` | Root + the `Object.assign` compound surface |
| `spinner-content.tsx` | `Spinner.Content`, the rotating layer |
| `spinner-arc.tsx` | The default arc glyph |
| `spinner.context.tsx` | `SpinnerContext`, `useSpinner()`, `useSpinnerContext()` |
| `spinner.variants.ts` | Pure `tv()` slots + resolvers, no RN imports |
| `spinner.variants.test.ts` | |

## Design

- **Sizes**: the icon scale, shared outright — `SPINNER_SIZES` *is*
  `ICON_SIZES`, `xs`…`2xl` (14/16/18/20/24/32pt) — or an explicit number. A
  spinner stands in for an icon, so the two must agree on what `md` means. **The root is the only sized box** — `Spinner.Content` is
  `size-full` and the arc carries no width or height at all, because
  react-native-svg resolves both to `'100%'` when neither is set. That
  `size-full` is load-bearing: content-size the middle layer and the percentage
  resolves against an indefinite parent, collapsing the glyph to zero.
  **Colours**: `default`, `success`, `warning`, `destructive`, plus any token the
  theme emits (`primary-foreground`, `muted-foreground`) or a literal
  (`#EC4899`). A Tailwind palette name like `emerald-500` only resolves if some
  utility class already pulled that variable into the build — otherwise the
  token is unresolved and nothing is drawn. Prefer the semantic tokens.
- **Size and colour are inherited, not passed** — through exactly one path, the
  nearest `IconDefaultsProvider`, falling back to `md` on `foreground`. A
  [`Button`](../button/AGENTS.md) already wraps the spinner it composes in with
  its own icon class and variant foreground, so the spinner does **not** read
  the button's context: a second path would recompute the same two values and
  could drift from them. An explicit `size` or `color` always wins — the
  precedence [`Icon`](../icon/AGENTS.md) follows.
- **Any child is the glyph**, wrapped in a `Spinner.Content` automatically so it
  still rotates — a custom icon or asset needs nothing but to be passed in.
  `Spinner.Content` is the rotating layer itself, so write it out by hand only
  when that layer needs styling.
- **`speed` belongs to the root**, not to `Spinner.Content`. It rides the
  spinner's context alongside the resolved size and colour, so every part of the
  spinner turns at one rate and a caller never reaches past the root to set it:
  `<Spinner speed={0.7}>` — 1 is one full turn per 900ms.
- **The default glyph is drawn from SVG primitives**, not a Central Icon — the
  set has no loader glyph. Rule 5 governs *icons*; primitives are fine.
- **The arc's caps are `butt`, and its round head is a separate `Circle`.** The
  two half-rings share the endpoint at the bottom of the ring, where both sit at
  `SPINNER_ARC_JOINT_OPACITY`. Round caps there stack, and two semi-transparent
  discs composite to roughly 0.8 alpha — a bright dot straddling the joint,
  opposite the head, at every size. Butt caps abut instead, and the one end that
  wants rounding gets a disc of its own, drawn last so it sits on top; the tail
  terminates fully transparent at that same point, so its flat end is invisible.
  Do not put `strokeLinecap="round"` back.
- **The gradient stops are angle-compensated, and run in user space.** A linear
  gradient fades along its axis and that axis is `y`, but a point at angle θ
  clockwise from the top sits at `y = 12 - 10·cos θ` — so two stops alone make
  the fade stall near 3 and 9 o'clock and race through 12 and 6, and the ring
  reads as a bright chunk beside a flat grey quadrant rather than as an even
  comet. `spinnerArcStops` places each stop at the offset the arc actually
  occupies at that angle while stepping the opacity evenly, which inverts the
  skew; it is pure, so `bun test` pins the whole ladder.
  `gradientUnits="userSpaceOnUse"` then keeps the endpoints exact, where an
  object bounding box would leave open whether a given renderer includes the
  stroke — which shifts both ends off 0 and 1 and clips the head and the tail.
- **The rotation sets `ReduceMotion.Never` deliberately.** Under the default
  `System` policy `withTiming` completes instantly while the OS reduce-motion
  setting is on, so `withRepeat(-1)` would spin a zero-length animation forever.
  A status indicator is not decorative motion.
