# Icon

Renders a Central Icon at a theme-aware size and colour. Pattern A in
[The three component patterns](../../../AGENTS.md#the-three-component-patterns) —
a styled wrapper with no state and no compound surface, which also reads
`IconDefaultsProvider` so a parent can set size and colour for its whole subtree
instead of every call site repeating them.

`import { Icon } from "@/components/ui/icon";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/icon` |
| `icon.tsx` | `Icon`, the `IconGlyph` proxy and the one `withUniwind` wrapper (see rule 7) — internal below `Icon` |
| `icon.context.tsx` | `IconDefaults`, `IconDefaultsProvider`, `useIconDefaults()` |
| `icon.variants.ts` | Pure `tv()` + the size-class ladder, no RN imports |
| `icon.variants.test.ts` | |

## Design

- **Props**: `icon` — required, a Central Icon component; `size` — a named step
  or an edge length in points; `color` — a theme colour token, a CSS variable
  name or a literal; `className` — a `size-*` utility. It extends `SvgProps`
  with `color`, `width` and `height` removed, because those three are the axes
  `Icon` owns: `color` is resolved through the theme, and width and height
  arrive as the glyph's `size` prop rather than as props of their own.
- **Sizes**: `xs`, `sm`, `md`, `lg`, `xl`, `2xl` — 14/16/18/20/24/32pt, held as
  `size-icon-*` token classes rather than numbers, plus a numeric escape hatch.
  With no `size`, no `className` and nothing to inherit the fallback is
  `size-icon-lg`, 20pt, on the `foreground` token.
- **Precedence is a five-source ladder** and it is shared with `Spinner`, so it
  is documented once in the package doc — see
  [Sizing](../../../AGENTS.md#sizing) for the table and for why a numeric size
  can never become a class. `resolveIconSizeClass` builds the first four sources
  as one `cn()` chain, so the last `size-*` wins; a numeric `size` bypasses the
  chain entirely.
- **Overriding through `className` uses `size-*`, not `w-*` with `h-*`.**
  tailwind-merge conflicts `size` into `w`/`h` but not the reverse, so a trailing
  `w-6` will not clear a leading `size-5`.
- **Size and colour are inherited, not passed.** `IconDefaultsProvider` supplies
  the class and the token that an unstyled `Icon` in its subtree adopts, and
  `useIconDefaults()` reads the nearest one — `null` outside a provider. This is
  what lets an icon be *composed into* a component rather than passed as a prop:
  `<Button><Icon icon={IconPlus} /><Button.Label>Add</Button.Label></Button>`
  sizes and tints the icon for the button's variant, with no `startIcon` prop and
  no colour repeated at the call site. An explicit `size` or `color` on the icon
  still wins.
- **The components that publish it** are
  [Button](../button/AGENTS.md), `Badge`, `Switch.Content`, `Switch.Thumb`,
  `Tabs.Trigger`, `Accordion.Trigger`, `Accordion.Indicator`,
  `Input.Group`'s decorators, `ListGroup.ItemPrefix`, `Screen.Navbar.BackButton`
  and [Spinner](../spinner/AGENTS.md) — each carrying its own step on the shared
  scale and its own variant's foreground token.
- **An icon's size is a class; an icon's colour is a token.** The asymmetry is
  deliberate — a colour class cannot express a literal like `#EC4899` or reach an
  SVG paint prop, so `color` is resolved through the active theme by
  `useThemeColor` instead. See [Theming](../../../AGENTS.md#theming).
- **`iconVariants` has no `defaultVariants`, on purpose.** The fall-through *is*
  the feature: a default would emit from inside that same `tv()` call, ahead of
  an inherited class in the merge, and the fallback would then beat the enclosing
  component. An unnamed axis must reach the inherited provider rather than be
  answered locally, so `resolveIconSizeClass` orders the sources instead. The
  variant test pins it — without a size, `iconVariants()` emits no `size-*` at
  all.
- **The `withUniwind` wrapper is forced, not stylistic.** A className cannot size
  a Central Icon through a style: `CentralIconBase` spreads its props onto
  `<Svg>` *before* setting its own `width`/`height`, and `react-native-svg`'s
  `Svg.render()` then merges `{...style, ...props}` and pushes the
  width/height-derived styles onto the root **last**, so a `size-4` that resolved
  to `style.width` is overridden every single time. `icon.tsx` runs the class
  through `withUniwind` in manual mode to recover the width and hands that number
  to the glyph's `size` prop.
- **The wrapper goes on a proxy that takes the glyph as data.** `IconGlyph`
  renders whatever component it is handed, so a *single* `withUniwind` covers the
  whole two-thousand-icon set instead of one per glyph — still one component
  wrapped once, in one file. It also drops the `className` that sized it, because
  `withManualUniwind` spreads the original props straight through and
  `CentralIconBase` would forward a stray `className` onto the native SVG view,
  where nothing interprets it.
- **`withUniwind` is called at module scope.** In render it would mint a new
  component type every frame and remount the icon.
- **This is the single sanctioned carve-out from rule 7, and it is already
  spent.** Do not wrap a Central Icon directly, do not wrap the proxy anywhere
  else, and do not add a second wrapper for `Svg`.
- **`Icon` and `Spinner` share one scale.** `SPINNER_SIZES` *is* `ICON_SIZES`, so
  `size="md"` is the same edge length in both and one can stand in for the other
  with nothing moving — which is what makes a button's loading swap free. See
  [Spinner](../spinner/AGENTS.md).
- **Central Icons only**, via `@/lib/icons/central` — never Lucide,
  Hugeicons, or anything else. That is rule 5.
- **`icon.variants.ts` is free of React Native imports** so the whole ladder is
  reachable from `bun test` — `resolveIconSizeClass`, `isIconSize` and
  `iconVariants` are all pure. See [Testing](../../../AGENTS.md#testing).

## Known gaps

- **`Icon` is the only component with no playground route.** Step 5 of
  [Adding a component](../../../AGENTS.md#adding-a-component) requires
  `apps/playground/src/app/(components)/{name}.tsx` plus a row on the index, and
  exempts only a component with nothing to render — `DelacourProvider`. `Icon`
  renders, so it does not qualify for that exemption; it is verified today only
  indirectly, through the glyphs on the other routes.
