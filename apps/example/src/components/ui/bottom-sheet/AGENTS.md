# BottomSheet

A panel that slides up from the bottom of the screen, over everything — a
Uniwind skin on `@delacour/react-native-bottom-sheet`, this repository's own
headless engine.

`import { BottomSheet, BottomSheetProvider } from "@/components/ui/bottom-sheet";`

The engine is an **optional peer**, like `@delacour/react-native-charts` is
for `Chart`: an app that never imports this subpath never resolves it, and
never has to build its native peer `react-native-teleport`. The consequence is
the one thing a consumer has to do that no other component asks of them —
**mount `BottomSheetProvider` once**, inside `DelacourProvider` and around the
navigator. `DelacourProvider` cannot mount it without importing the engine. See
[DelacourProvider](../provider/AGENTS.md).

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/bottom-sheet`. The compound, the variants, the provider and the hooks re-exported from the engine, and the two compat aliases below |
| `bottom-sheet.tsx` | `BottomSheet` — the engine's root with this library's defaults: `bottomInset` from the safe area, the two haptics, the stale-keyboard guard. The `Object.assign` names every part |
| `bottom-sheet.variants.ts` | The slotted `tv()` — `overlay`, `background` (with a `detached` variant), `handle`, `handleIndicator`, `content`, `scrollContent`, `steps`, `step`, `footer`, `stickyFooter`, `close`, `title` — and the numeric constants the engine's props take |
| `bottom-sheet-trigger.tsx` | `BottomSheet.Trigger` — this library's `Pressable`, or `asChild` to donate the press |
| `bottom-sheet-portal.tsx` | `BottomSheet.Portal` — the engine's portal, plus whether it teleports to `"root"` |
| `bottom-sheet-overlay.tsx` | `BottomSheet.Overlay` — the engine's scrim in `bg-overlay`, opacity 1; registers the sheet as modal for screen readers |
| `bottom-sheet-provider.tsx` | `BottomSheetProvider` — the engine's provider, sharing teleport with `OverlayProvider`, hiding the app under a modal sheet |
| `bottom-sheet-modal.context.tsx` | **Leaf.** The modal-sheet registry context, the root-host context and `useHideAppWhileModal` |
| `bottom-sheet-container.tsx` | `BottomSheet.Container` — the panel; writes `Background` and `Handle` when the caller writes neither |
| `bottom-sheet-background.tsx` | `BottomSheet.Background` — `bg-popover`, top corners rounded, every corner when detached |
| `bottom-sheet-handle.tsx` | `BottomSheet.Handle` — the engine's row with the pill inside it |
| `bottom-sheet-content.tsx` | `BottomSheet.Content` — the static body, gutter and gap on the measured box |
| `bottom-sheet-scroll-view.tsx` | `BottomSheet.ScrollView` — classes on an inner `View` |
| `bottom-sheet-flat-list.tsx` | `BottomSheet.FlatList` — classes on the content container |
| `bottom-sheet-section-list.tsx` | `BottomSheet.SectionList` — same |
| `bottom-sheet-legend-list.tsx` | `BottomSheet.LegendList` — built here with `createBottomSheetScrollable`, because `@legendapp/list` is this library's optional peer and not the engine's |
| `bottom-sheet-footer.tsx` | `BottomSheet.Footer` — inline by default, `sticky` to pin |
| `bottom-sheet-close.tsx` | `BottomSheet.Close` — the engine's `Close asChild` around `Pressable feedback="fade"` and an `IconCrossSmall` |
| `bottom-sheet-title.tsx` | `BottomSheet.Title` — the engine's `Title asChild` around `Text.Header` |
| `bottom-sheet-description.tsx` | `BottomSheet.Description` — `Description asChild` around a muted `Text.Paragraph` |
| `bottom-sheet-text-input.tsx` | `BottomSheet.TextInput` — `Input` spread with the engine's registration |
| `bottom-sheet-steps.tsx` | `BottomSheet.Steps` and `BottomSheet.Step` — the multi-step body, gutter on the stack and vertical padding on each step |
| `use-bottom-sheet-input.ts` | `useBottomSheetInput()` — the engine's `useBottomSheetTextInput` under the name this library shipped |

`Host` is the engine's own, re-exported unchanged. `Portal` and `Provider`
wrap the engine's for screen-reader modality only; they draw nothing a class
could reach.

## Anatomy

```tsx
<BottomSheet snapPoints? dynamicSizing? maxDynamicContentSize? detached? keyboardBehavior? …>
  <BottomSheet.Trigger asChild><Button /></BottomSheet.Trigger>
  <BottomSheet.Portal inline? hostName?>
    <BottomSheet.Overlay pressBehavior? />
    <BottomSheet.Container backgroundClassName? handleClassName? handleIndicatorClassName?>
      <BottomSheet.Background /> <BottomSheet.Handle />   // written for you unless you write them
      <BottomSheet.Content> | <BottomSheet.ScrollView> | <BottomSheet.FlatList> | <BottomSheet.SectionList> | <BottomSheet.LegendList> | <BottomSheet.Steps controller>
        <BottomSheet.Close /> <BottomSheet.Title /> <BottomSheet.Description /> <BottomSheet.TextInput />
      <BottomSheet.Footer sticky? />
    </BottomSheet.Container>
  </BottomSheet.Portal>
</BottomSheet>

<BottomSheetProvider />          // once, in the app root
<BottomSheet.Host name="modal" /> // last in a native modal screen
```

`Container` is the panel that moves; `Content` is the static body inside it.
Sizing and behaviour — `snapPoints`, `dynamicSizing`, `maxDynamicContentSize`,
`keyboardBehavior`, `detached`, the haptics — are the **root's** props. The
engine's names win everywhere; this skin aliases nothing.

## What the engine owns

Everything that is not a class. The open state and the intent queue; the
height-space geometry and the snap points; the handle and content pans and how a
list shares a finger with them; the keyboard — who owns it, `interactive` /
`extend` / `fillParent` / `none`, the lift and the restore; the sticky footer's
line and the safe-area band under it; the teleport portal, the hosts, the
registry that stacks sheets and answers Android's back button; the detached
card's frame; the step machine and the height that glides between steps; and
the accessibility — the panel is a modal view labelled by the title, the
handle is the one adjustable element. Its `AGENTS.md` and the `AGENTS.md` in
each of its `src/*` folders carry the reasoning and the device verification;
read those before touching behaviour, because behaviour is not here.

## What this skin owns

- **Classes, from one `tv()`.** Every part is the engine's part with a slot
  from `bottomSheetVariants` on it. The engine's parts take `style`, not
  `className`, so each is wrapped in `withUniwind` **once, at module scope** —
  in render the wrapper would mint a new component type every pass, remount
  the panel and re-attach the pans. Rule 7's carve-out for third-party
  components applies: the engine is another package.
- **Where the classes land.** `Content`, `Footer` and `Steps` hand `style` to
  the engine's *measured* inner view, so a class there is height the dynamic
  snap point counts. `ScrollView` puts its content classes on an inner `View`
  rather than the content container, so the one style this file writes there —
  the gap above a pinned footer — has a single writer. The three virtualised
  lists have no inner box, so theirs go on `contentContainerClassName`; the
  engine flattens the resulting array to one object before the list measures
  it, which is what makes that safe where it was not with the library this
  replaces.
- **`Container` writes `Background` and `Handle` for you** when the children
  hold neither, detected by element type and inside fragments too. Write either yourself and it writes
  nothing: a custom handle with no surface is a decision. The three
  `*ClassName` props reach only the parts it writes.
- **`Title` and `Description` are `Text` presets**, through the engine's
  `asChild`. The engine contributes the `nativeID` the panel is labelled by and
  the heading role; the preset contributes the type. The `title` slot carries
  `pr-8` for the close control and nothing else — a `text-lg` there would be a
  second definition of `Text.Header` — and the test asserts it.
- **`Close` and `Trigger` are this library's `Pressable`**, through `asChild`.
  The engine's press handler is donated to the pressable rather than wrapping
  it, because two tap gestures in an ancestor/descendant pair give the touch to
  the descendant and a wrapping trigger never fires. `Close` presses with
  `fade` and a 12pt slop, for `Badge.CloseButton`'s and `Checkbox`'s reasons:
  a 20pt icon plus 12pt on each side is the 44pt minimum.
- **The root fills in three defaults.** `bottomInset` is `useSafeAreaInsets().bottom`,
  so the engine reserves the home-indicator band and nobody pads for it by
  hand. `onSnapPointHaptic` is `Presets.System.selection` and `onCloseHaptic` is
  `Presets.System.impactLight` — pulsar's presets are worklets, so they are
  passed as they are; a JS function there is `undefined is not a function` on
  the UI thread. And `useKeyboardAnimationGuard()` runs on mount, the same
  stale-keyboard repair `Screen.Footer` runs. `topInset` stays at the engine's
  zero, so a `%` snap point is the fraction of the window it always was.
- **Android back skips a sheet under an overlay.** Sheets and overlays keep
  separate registries, and `BackHandler` calls the newest listener first. The
  engine re-subscribes when its methods change, so after a parent render the
  sheet's listener is newer than a dialog's. The root turns `closeOnBack` off
  while `topOverlay()` of the `OverlayProvider` registry is set, so back closes
  the dialog and not the sheet under it.
- **`Footer.sticky` defaults to `false`**, matching `Screen.Footer`, and this is
  the one engine default the skin overrides. A pinned footer takes
  `padding={BOTTOM_SHEET_FOOTER_PADDING}` through the engine's prop rather
  than a class, so the padding is inside the box the snap point measures; the
  `stickyFooter` slot carries the gutter, the surface and the hairline, and
  the test asserts it carries no vertical padding.
- **A scrim makes the sheet modal for screen readers.** The panel's
  `accessibilityViewIsModal` hides only its siblings in the teleport host, not
  the app, and sheets are not in `OverlayProvider`'s registry. So while a sheet
  with an `Overlay` is presented in the `"root"` host, the overlay registers
  with `BottomSheetProvider`, which sets `accessibilityElementsHidden` and
  `importantForAccessibility="no-hide-descendants"` on the view around its
  children. The `"root"` host draws beside that view, so the sheet stays
  reachable. An inline sheet, a sheet in another `BottomSheet.Host` (inside the
  app view) and `enableTouchThrough` do not register. Under Jest's inline
  teleport (`isTeleportInline()`) it hides nothing, as `OverlayProvider` does.
- **The overlay's opacity is 1**, because `--overlay` carries its own alpha and
  the two theme variants carry different ones. `BOTTOM_SHEET_OVERLAY_OPACITY`
  and `BOTTOM_SHEET_BACKDROP_INDICES` restate the engine's defaults so a test
  can pin them against the theme.
- **`LegendList` is built here.** The engine exports
  `createBottomSheetScrollable` and ships `ScrollView`, `FlatList` and
  `SectionList`; `@legendapp/list` is this library's optional peer, so its
  body is made here, once at module scope, and registered as a flat list.

## A sheet that filters as you type holds its height

A sheet sized to its content (`dynamicSizing`, the engine's default) re-measures
whenever its rows change, so a search field over a list resizes the sheet on
every keystroke that drops or restores a row. Any sheet whose content changes
while an input in it has focus holds one height instead:

- **Fixed snap points.** `dynamicSizing={false}` and a `snapPoints` of one
  height — the SearchBar demo's `"50%"`. The keyboard lifts the sheet as usual,
  and nothing it types moves it.
- **A floor at the cap.** A scrollable list that should fill the sheet keeps
  `dynamicSizing` and `maxDynamicContentSize`, passes
  `keyboardLiftLimit="maxDynamicContentSize"`, and floors its content at the
  cap — `Select`'s searchable sheet. Under that limit the keyboard covers the
  sheet's bottom rather than lifting it, which a fixed snap point at the cap
  cannot do: the limit only clamps a dynamically sized sheet, and an
  unclamped lift from the cap carries the top under the status bar.
- **A held snap point.** `Combobox` computes its one snap point at open, for
  the keyboard it expects, and keeps it until the next open.

Scrolling the filtered list should not drop the keyboard either: `Select` and
`Combobox` pass `enableBlurKeyboardOnGesture={false}` to the sheet and
`keyboardDismissMode="none"` to the list while a search field is in it.

A form whose fields never change the content's height needs none of this.

## Compat

Two names survive from the previous implementation for callers that imported
them: `useBottomSheetInput()` is the engine's `useBottomSheetTextInput()`, and
`BottomSheetHandle` is the engine's `BottomSheetRef`, marked deprecated.
`resolveSheetBottomInset` and `resolveSheetScrollEndPadding` moved into the
engine's `./core` and are re-exported from here. `useBottomSheetContext()` is
the engine's `useOptionalBottomSheet()`.

Gone: `BOTTOM_SHEET_KEYBOARD_DEFAULTS` (the engine's `keyboardBehavior` and
`keyboardBlurBehavior` defaults are the same values, and there is no Android
input-mode prop), `resolveFooterPlacement` (nothing is hoisted any more), and
the container and portal contexts (the engine provides its contexts once, at
the root, and teleport keeps the React tree in place so they reach every part).

## No longer needed

The previous implementation, on a third-party modal, documented sixteen
workarounds. Every one of them is either the engine's job now or simply not a
problem it has:

- dismiss-before-present deadlock — state opens, intents move; closing a closed
  sheet is nothing
- the backdrop stealing taps from a `TextInput` — the overlay is a `Pressable`
  written before the panel, resolved by view order
- context lost across the portal — teleport moves the native view, not the tree
- `accessible` collapsing the panel into one element — the panel is a modal
  view, never `accessible`
- the footer's `bottomInset` band — the geometry's footer line holds still
  through the keyboard; the band is a spacer it owns
- `enableFooterMarginAdjustment` committing a render per frame — the body's
  spacer is an animated style off `footerHeight`
- `android_keyboardInputMode` — keyboard-controller owns the window
- stale keyboard values — the root runs the guard; the engine runs the same
  reconcile on every presentation
- an input's drag captured by the sheet — the content pan fails on horizontal
  movement and yields to the field
- `snapPoints` identity re-deriving under an open sheet — normalised once per
  change, on the UI thread
- nesting a sheet in a sheet — the registry stacks them; `stackBehavior` and
  `dismissAll` are for exactly that
- `ScrollView` needing `dynamicSizing={false}` and `snapPoints` — a list's
  content size is the dynamic snap point
- lifting `Overlay` and a sticky `Footer` out of the tree as render props —
  every part renders where it is written
- a `Content` inside a `Container` paying the safe-area band by hand — the
  geometry reserves it
- a sheet mounted while the keyboard was up floating a keyboard-height off the
  bottom — ownership is decided per keyboard, sticky through a transition
- two footers, one inline and one sticky, needing a placement rule — a footer
  is where you write it

## Structure

Pattern B, compound and context — the contexts are the engine's. The parts
never import `./bottom-sheet` or `./index` (rule 3); they import the engine and
`./bottom-sheet.variants`. The variants and the constants are unit-testable;
the behaviour is the engine's and is verified there, and the skin on a
simulator through `apps/playground`'s Bottom sheet galleries.
