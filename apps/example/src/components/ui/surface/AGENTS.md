# Surface

A rounded container on one of the theme's surface fills — the plane a card, an
alert or a settings panel is drawn on. A single styled `View` with a context, so
components built on it (`Card`, `Alert`) can read the plane they sit on.

`import { Surface } from "@/components/ui/surface";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/surface` |
| `surface.tsx` | `Surface` |
| `surface.context.tsx` | `SurfaceProvider`, `useSurface()`, `useSurfaceContext()` |
| `surface.variants.ts` | The `tv()`, `SURFACE_FOREGROUND_TOKENS`, and the two pure resolvers — no RN imports |
| `surface.variants.test.ts` | |

## Design

- **The API is `variant`, `padding`, `className` and `children`, and it stays
  that small.** `Card` and `Alert` are built on this; every prop added here is
  one they inherit and have to document. Anything else a caller needs — a
  margin, a tinted border, a fixed height — is a class, merged last through the
  `tv()`.
- **Variants**: `default`, `secondary`, `tertiary`, `transparent`.
  **Padding**: `none`, `sm`, `md`, `lg` — `p-0`, `p-3`, `p-4`, `p-6`. `md`
  rather than `default` for the middle step, so one step name means "the
  default step" across the library.
- **The variants are a ladder, not a palette.** `default` is `bg-card` with a
  `border-border` hairline; `secondary` and `tertiary` are the fills beneath it;
  `transparent` keeps the padding and corner and paints nothing. Only `default`
  colours its border: in light `--card` sits a percent above `--background`, and
  without the hairline a card on a page is white on near-white. Every variant
  still reserves the same one-point `border`, so changing variant never moves
  the content.
- **A surface that names no variant steps from the one it sits in.**
  `resolveSurfaceVariant` makes a top-level surface `default`, and a nested one
  `default → secondary → tertiary → secondary`. `tertiary` is *quieter* than
  `secondary` — half a step back toward the page, see `theme.css` — so a strict
  ascent would run out of fills at the fourth level; what the resolver
  guarantees, and the tests assert, is that a surface never resolves to the fill
  it sits on. An explicit `variant` always wins.
- **A transparent surface passes its parent's plane through.**
  `resolveSurfacePlane` publishes the plane a surface's children sit on, and for
  `transparent` that is whatever it sits on itself. Without it, a surface inside
  a transparent wrapper inside a card would restart at `default` — the card's
  own fill — and disappear into it.
- **The corner is `rounded-lg`, with `border-continuous`.** `rounded-lg` is the
  step `--radius` names, which is the card corner — see the corner-scale note in
  [the package AGENTS.md](../../../AGENTS.md). `border-continuous` is Uniwind's
  utility for iOS's `borderCurve: "continuous"`, the squircle rather than a
  circular arc; Android ignores it. It is registered in `TW_MERGE_CONFIG` as a
  class group of its own — unregistered, tailwind-merge read it as a border
  *colour* and dropped it against `border-border`.
- **`padding="none"` clips, and nothing else does.** It is the step for content
  bled to the edge — an image, a chart — and that content has to take the
  corner with it. Clipping at every padding would crop anything a child draws
  past its own box.
- **No shadow.** Nothing in this package casts one — React Native's shadow
  props disagree between platforms — so depth here is carried by fill, and the
  tests assert no variant emits one. A caller who wants one writes `shadow-md`
  and gets the theme's `--shadow-md`.
- **No text treatment.** The root carries no `text-*` (rule 1), and the surface
  publishes no `TextClassProvider` either: `Text`'s presets set their own
  colour, so the cascade would reach only a bare `Text` — and a provider marks
  every `Text` beneath it as nested, which strips `Text.Code` of its chip.
  `SURFACE_FOREGROUND_TOKENS` maps each fill to its `X-foreground` token for a
  caller that wants it, as a class or through `useThemeColor`.
- **No role.** A surface is layout, not a landmark; it adds nothing a screen
  reader could announce. `ViewProps` pass through, so a caller that does mean
  one — `accessibilityRole="summary"` — sets it.
