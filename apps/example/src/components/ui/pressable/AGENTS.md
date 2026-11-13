# Pressable

The interaction primitive every pressable component in this library builds on —
a Gesture Handler tap drives the press feedback and the haptic on the UI thread,
and only `onPress` and `onLongPress` cross back to JS.

`import { Pressable } from "@/components/ui/pressable";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/pressable` |
| `pressable.tsx` | The Gesture API primitive |
| `pressable.variants.ts` | Shared feedback vocabulary and screen-reader activation routing, no RN imports |

## Design

- **`pressable.variants.ts` holds no `tv()`, on purpose.** Its values are
  opacity and scale *interpolation targets* read by a worklet on the UI thread
  (`1 - pressed.value * (1 - targetOpacity)`), not styles. A worklet cannot
  compile a className, so `tv` is the wrong tool here — a deliberate exception
  to pattern C, not an oversight.
- **`feedback` is the shared vocabulary**: `scale`, `fade`, `scale-fade`,
  `none`, defined once in `pressable.variants.ts`. Every pressable in the
  library resolves through it rather than keeping a private map. A control
  changes its **default** and nothing else — [`Button`](../button/AGENTS.md) to
  `scale`, [`ListGroup.Item`](../list-group/AGENTS.md) to `fade`. Neither
  narrows the union: a second definition of a prop the control does not change
  is a definition that can drift, which is why the button's own
  `ButtonFeedback` was removed.
- **`scale-fade` is composed, not spelled out.** Its scale comes from `scale`
  and its opacity from `fade`, so tuning either single-axis mode carries
  through and the name keeps describing what the mode does. A test asserts it.
- **`pressedScale` / `pressedOpacity` win on the axis they name**, and leave the
  other to `feedback`. They are the escape hatch for a value the named modes do
  not cover, not an alternative API — `??` is the merge, so an explicit `0` is a
  value rather than an absence.
- **The no-feedback fallback is unnamed on purpose.** A bare `Pressable` presses
  to `{ opacity: 0.9, scale: 0.97 }`, which fades less than `fade` does. Naming
  it would either change what a bare pressable has always done or force
  `scale-fade` to fade less than `fade`.
- **`disabled` vs `busy`.** Both block the gesture; only `disabled` announces
  the control as disabled. Use `busy` for a temporary state the component clears
  itself, so assistive tech reports a control that is momentarily unavailable
  rather than one that is inert. A caller who needs the announcement without
  the block passes `accessibilityState={{ busy: true }}` instead:
  `resolvePressableAccessibilityState` lets a caller's state add `true` to
  either key but never override a gating prop with `false`. Before it, the
  prop's default `false` overwrote a caller's `busy` silently —
  [`Marker`](../marker/AGENTS.md), a running step that must stay tappable,
  is the case that found it. Neither applies any opacity — that is the
  caller's variant's job, and the point below is what lets it do that job.
- **A screen reader's activation is wired to `onPress`, not left to the
  gesture.** A Gesture Handler tap only ever sees touches. VoiceOver's
  double-tap calls `accessibilityActivate`, which React Native answers only
  when `onAccessibilityTap` is set; without it UIKit synthesises a touch at the
  element's centre and the gesture happens to catch it. TalkBack's double-tap
  performs `ACTION_CLICK`, which React Native routes only to a listed
  `activate` action and otherwise drops into `View.performClick`, with no
  listener behind it. `resolvePressableActivation` decides per platform:
  `onAccessibilityTap` on iOS (an `activate` entry there would become a literal
  "activate" in every button's rotor, since Fabric lists every entry as a custom
  action), an appended `activate` action on Android. Both go through
  `isPressableInteractive`, the same guard the gesture uses, so a disabled or
  busy control consumes the activation and does nothing. Returning `YES` from
  `accessibilityActivate` also stops UIKit synthesising the touch, so one
  double-tap is one `onPress`. A caller that lists `activate` itself — the
  `NumberInput` stepper, `Message`, `FlipCard`, `SectionRail.Trigger`,
  `ProgressButton` — owns it on both platforms and the pressable wires nothing;
  a caller's own `onAccessibilityTap` wins the same way. A caller's other
  actions and its `onAccessibilityAction` are merged in, never replaced.
- **TalkBack's long press is wired to `onLongPress` the same way.**
  Double-tap-and-hold performs `ACTION_LONG_CLICK`, which React Native routes
  only to a listed `longpress` action and otherwise drops into an empty
  `View.performLongClick` — so on Android the pressable appends `longpress`
  whenever there is an `onLongPress`. iOS gets no entry: VoiceOver's
  double-tap-and-hold passes a held touch through, which the long-press gesture
  already recognises, and a `longpress` entry would only become a rotor custom
  action. A caller that lists `longpress` itself — `SelectionMode.Item`,
  `Attachment` — owns it, as with `activate`. The dispatch is two pure functions
  in `pressable.variants.ts`: `dispatchPressableAccessibilityAction` maps an
  action name to its handler, and `invokePressableHandler` is the
  `isPressableInteractive` gate every screen-reader path calls exactly once.
  A gated control consumes both actions and fires neither.
  `Button`, `ListGroup.Item`, `Screen.Navbar.BackButton`, `Dialog.Close`,
  `BottomSheet.Close` and every other `Pressable` consumer inherit it.
  Verified on an iOS simulator with `AXPress` through Simulator.app's
  accessibility bridge, which calls `accessibilityActivate` — `warden ui press`
  does not, it synthesises a touch, so it cannot tell the two paths apart.
- **A className's opacity is multiplied into the press, never overwritten.**
  The press feedback is an animated style, and an animated style owns every key
  it writes on the view — so its resting `opacity: 1` silently replaced a
  variant's `opacity-50`, and a disabled `Button`, `Badge`, `Checkbox`,
  `ListGroup.Item` or `Input.Group` never faded while blocking taps correctly.
  The root now resolves its own `className` with Uniwind's
  `useResolveClassNames` and animates `rest * press` instead, with
  `resolveRestOpacity` guarding the value. A press still fades relative to the
  rest — a disabled control cannot be pressed, so the two never compound. No
  unit test could have seen the bug; it was found on a simulator.
- **A worklet crosses back to JS with `scheduleOnRN`**, imported from
  `react-native-worklets` — never Reanimated's `runOnJS`, which since Reanimated 4
  is a deprecated shim that forwards to exactly that call. `scheduleOnRN(fn, ...args)`
  takes the arguments itself, so there is no second call: `runOnJS(onPress)()`
  becomes `scheduleOnRN(onPress)`. The same rename covers `runOnUI` →
  `scheduleOnUI`, which `use-keyboard-state-sync` already uses. A Biome
  `noRestrictedImports` rule in `@delacour/biome-config` fails the build on the
  deprecated names, so this cannot regress quietly.
- **A worklet's body must be self-contained.** The press feedback runs on the UI
  thread and cannot rely on a module-scope helper: factoring its
  `Math.min(1, Math.max(0, …))` clamp into a `clampUnit` helper — itself marked
  `"worklet"` — crashes the UI thread with `undefined is not a function`, because
  the helper is not captured into the worklet's closure. No unit test sees it,
  since on the JS thread the helper resolves perfectly.
  [`Screen`](../screen/AGENTS.md)'s border ramps write the same clamp out twice
  for this reason.
- **`asChild` reads its child with `Children.toArray`, not `Children.only`.**
  `Children.only` throws React's own "expected to receive a single React element child"
  for a text child, so the `isValidElement` check below it, with its documented
  message, was unreachable. The count is already checked to be 1, so the first
  entry is the child; a text child or fragment now reaches the documented error. A
  render test pins it.
