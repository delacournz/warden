# DelacourProvider

Every provider an app needs at its root, in one component. Mount it once, around
everything — a root layout, an `App.tsx`.

`import { DelacourProvider } from "@/components/ui/provider";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/provider` |
| `provider.tsx` | `DelacourProvider` — the app's root layer stack; its `displayName` is `DelacourUI.Provider`, because prefix-plus-symbol would stutter and this matches its export subpath |

## Design

- **Five layers, outermost first**: `GestureHandlerRootView` →
  `SafeAreaProvider` → `KeyboardProvider` → `<KeyboardStateSync />` beside
  `CalmMotionProvider`, which wraps the children. The order is not stylistic. The gesture root has to be an ancestor
  native view of every handler a `Pressable` creates, and its absence is
  *silent* — no error, no warning, presses simply stop landing.
  `KeyboardStateSync` has to be a CHILD of `KeyboardProvider`, because it calls
  `useKeyboardContext()`, and it stays a SIBLING of the children rather than
  wrapping them: the repair is global and has to outlive any layer that can
  remount.
- **`initialMetrics` defaults to `initialWindowMetrics`, and that is
  load-bearing.** `SafeAreaProvider` renders `null` — not unstyled children,
  *nothing* — until its native view reports the first `onInsetsChange`, so
  without the seed every cold start shows a blank frame. The seed is a snapshot
  taken at native module init, so it is stale when the app launches into a
  rotated or split-screen window — stale for exactly one commit, because the
  native measurement overwrites it. A blank frame on every launch is the worse
  trade. `initialMetrics={null}` opts out: a default parameter only fires on
  `undefined`, so `null` is a value rather than an absence, the same rule
  `pressedScale` follows.
- **`style` reaches the gesture root and carries no default.**
  `GestureHandlerRootView` applies its own `{ flex: 1 }` whenever `style` is
  undefined, so merging one in here would both duplicate it and make the prop
  behave differently than it does upstream. Pass a style and that `flex: 1` is
  gone — include it yourself.
- **No per-layer escape hatches, and no layer-named props.** No
  `gestureHandler={false}`, no `safeAreaProps`, no `keyboardProps`. A boolean
  that turns off the gesture root has "nothing responds to a press" as its
  failure mode, which is the least debuggable outcome in the package. And a prop
  surface that names the layers changes shape every time a layer is added:
  `children`, `style` and `initialMetrics` say nothing about what is inside, so a
  future portal host or toast host is an edit to one file rather than a
  breaking change. An app that genuinely needs a different stack composes
  the providers by hand — they are all public from their own packages, and this
  is a convenience, not a gate.
- **A new layer goes innermost.** Anything that draws above the app — a
  portal host, a toast host — has to sit inside every provider it reads, so it
  wraps `{children}` and nothing else moves. A layer that brings a new native
  peer is a peer-dependency decision first.
- **`BottomSheetProvider` is the layer this component does not mount, and the
  reason is the peer decision above.** The sheet's engine,
  `@delacour/react-native-bottom-sheet`, is an **optional** peer of this
  library, the way `@delacour/react-native-charts` is: an app with no sheet
  never resolves it, and its native peer `react-native-teleport` never has to
  be in that app's build. An import here would make every app resolve both,
  sheet or no sheet. So the provider is exported beside `BottomSheet`, from the
  sheet's own subpath, and the app mounts it itself, once,
  inside `DelacourProvider` and around its navigator — innermost, exactly where
  the rule above puts it, because it reads the gesture root for its pans, the
  safe area for its insets and the keyboard values a sheet's footer rides.
  `apps/playground/src/app/_layout.tsx` is the reference mount. Without it a
  `BottomSheet.Portal` still renders, where it is written, as an inline sheet.
  The previous sheet library was a required peer while this component mounted
  its modal provider; nothing imports it any more.
- **`isMotionCalm` is a behaviour prop, not a layer-named one.** It feeds
  `CalmMotionProvider` (`hooks/use-calm-motion.tsx`), which `useCalmMotion()`
  reads beside the OS reduce-motion setting. It exists for E2E builds: a runner
  that waits for the screen to settle before each gesture (Argent waits up to
  3 s) pays the whole wait on a screen holding a never-ending loop. Only
  decorative loops ask — `Skeleton` today; `Spinner` and an indeterminate
  `Progress` are the behaviour and keep moving. The context defaults to `false`,
  so a component used without this provider (a `delacour add` copy in an app
  with its own stack) still honours reduce motion.
- **Deliberately not idempotent.** It does not detect an enclosing copy of
  itself. Nesting `GestureHandlerRootView` costs a `View`; nesting
  `SafeAreaProvider` seeds from the parent's insets and costs a native view;
  nesting `KeyboardProvider` is the one that actually breaks — two pairs of
  shared values, two sets of native observers, and the outer `KeyboardStateSync`
  repairing values nobody reads. That is also the only layer that cannot be
  detected: `useKeyboardContext()` returns a module-private default object
  outside a provider, that object is not exported, and the hook `console.warn`s
  whenever it hands one back, so a detection read would print a warning in every
  correctly-mounted app. A guard covering the two harmless layers and missing the
  harmful one is worse than none — it teaches callers that nesting is fine.
- **`react-native-keyboard-controller` is a required peer because of this
  component.** It was optional while [`Screen`](../screen/AGENTS.md) was the only importer: an app that
  never imported `Screen` never resolved it. The recommended root now imports it,
  so every app resolves it, and the flag had stopped describing reality — all it
  still did was suppress the install warning that would have explained the Metro
  resolution error coming out of the app's root layout. Rule 3's promise is
  per-subpath and survives intact: `/button` still pulls nothing
  keyboard-related.
- **Nothing here for `bun test`, and no `provider.variants.ts` to give it
  some.** The component is five nested elements and one default parameter;
  extracting a `resolveInitialMetrics()` would be a unit test of `??`. The rule
  that pure decisions live in a `*.variants.ts` has no decision here to
  relocate.
- **No gallery route.** See [Adding a component](../../../AGENTS.md#adding-a-component).
