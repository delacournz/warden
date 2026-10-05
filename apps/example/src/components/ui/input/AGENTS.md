# Input

A text field, and the box that can hold content beside it. Root plus
`Input.Group` and its two decorators, `Prefix` and `Suffix`.

`import { Input } from "@/components/ui/input";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/input` |
| `input.tsx` | Root + the `Object.assign` compound surface |
| `input-group.tsx` | `Input.Group`, plus its own nested surface |
| `input-group-decorator.tsx` | The shared body behind both decorators |
| `input-group-prefix.tsx` | `Input.Group.Prefix` |
| `input-group-suffix.tsx` | `Input.Group.Suffix` |
| `input.context.tsx` | `InputGroupProvider`, `useInputGroup()`, `useInputGroupContext()`, `useInputGroupPart()` |
| `input.types.ts` | Prop types shared by two or more parts |
| `input.variants.ts` | Pure `tv()` slots + resolvers, no RN imports |
| `input.variants.test.ts` | |

## Design

- **Variants**: `primary`, `secondary`. **Sizes**: `sm`, `md`, `lg` — the box
  height, the value's type scale and a decorator's icon step, on one axis.
- **The box is one slot with two homes, and that is the whole design.** The
  `root` slot of `inputVariants` lands on the `TextInput` when a field stands
  alone and on `Input.Group`'s row when it does not. `resolveInputFieldClass` is
  the decision, and it is pure, so `input.variants.test.ts` sweeps the entire
  matrix and asserts that every chrome utility a lone field wears is present on
  the group's row. A grouped field is therefore the *same* box rather than a
  similar one. **Do not give `Input.Group` a border, background or height of its
  own** — a second class string is a second thing that can drift, and the drift
  would be a one-pixel difference nobody notices until it is shipped.
- **The group owns the axes, because it owns the box.** `variant`, `size`,
  `isInvalid` and `isDisabled` live on `Input.Group`, and an `Input` inside one
  reads them from context — the same way a [`ListGroup.Item`](../list-group/AGENTS.md) takes no `variant`.
  The field's own copies of those props are ignored while it is grouped. One box,
  one set of axes; two would be two answers to the same question.
- **The two state axes have three sources, and the nearest wins:**
  `Input.Group` → the `Input`'s own prop → the enclosing [`Field`](../field/AGENTS.md). An `Input`
  inside `<Field isInvalid>` goes `destructive` with nothing said at the call site, and
  `<Input isInvalid={false} />` opts that one control out. `Input.Group` reads
  the `Field` too, or a decorated field inside an invalid one would stay calm
  while its label went red. Both are `??` chains, so an explicit `false` is a
  value rather than an absence — the rule `pressedScale` already follows.
- **Uniwind bridges the three colour *props*, so rule 7 is untouched.** A
  `TextInput`'s placeholder, caret and selection take a colour value, not a
  style, and uniwind's own `TextInput` — which is what a plain
  `import { TextInput } from "react-native"` resolves to, via its Metro
  resolver — accepts a className for each and compiles it to `styles.accentColor`.
  So this component wraps nothing in `withUniwind`, and the `Icon` carve-out
  stays spent exactly once.
- **Those classNames must be `accent-*` utilities.** `accent-muted-foreground`,
  never `text-muted-foreground`. Uniwind reads only `accentColor` off the
  compiled class, so anything else resolves to nothing: it warns once in
  development and leaves the prop undefined, which renders as the platform
  default rather than as an error. The defaults live in `input.variants.ts`.
- **`placeholderTextColorClassName` is `Omit`ed from `InputProps`.** Uniwind's
  name and ours would otherwise both reach the same colour, and a caller setting
  one while the component set the other is a bug with no error attached.
  `selectionColorClassName` keeps uniwind's name because it already is the name
  this package would have chosen; only its default is supplied here.
- **Focus is React state, not a `focus:` class.** Uniwind's `TextInput` does
  track its own focus, and `focus:border-ring` would work on a lone field — and
  do nothing at all for the box `Input.Group` draws around a grouped one, since a
  `View` cannot see a sibling's focus. One state, read by an `isFocused` variant,
  keeps the two identical and puts the decision somewhere `bun test` can reach.
- **Invalid outranks focus.** A field that went grey the moment it was tapped
  would drop the only signal it has that its value is wrong, exactly while the
  value is being corrected. The border, the caret and the decorators all stay
  `destructive`.
- **A multiline field turns its height into a floor**, and the row aligns to the
  top with it — centred decorators would drift down the side of a paragraph
  instead of sitting on its first line. `py-0` on the single-line branch is
  load-bearing on Android, where the platform's own vertical padding would
  otherwise push the value off centre inside a fixed height.
- **Prefix and suffix share one `decorator` slot and one implementation.** They
  are the same box in different places — the row's `gap` is what separates
  them — so a second identical slot would only be a second thing to keep in step.
  `input-group-decorator.tsx` is the shared leaf; the two part files name it.
- **A decorator wraps bare text in a `Text`.** `<Input.Group.Prefix>$</...>` is
  the shortest thing anyone will write and React Native cannot render a string
  outside a `<Text>`, so it would crash. Consecutive strings collapse into one —
  the same rule, and the same reason, as [`Button`](../button/AGENTS.md).
- **Pressing the group focuses the field.** A lone field is its own tap target
  edge to edge; a grouped one only covers the middle of the box, so the group is
  a `Pressable` with `feedback="none"` whose press focuses the field through the
  ref it shares on context. A `Button` inside a decorator still receives its own
  press.
- **There is no `Input.Label`, `Input.Description` or `Input.ErrorMessage`.**
  [`Text.Label`](../text/AGENTS.md) and `Text.Caption` already are those, and a label defined twice is
  a type scale that can drift. `apps/playground`'s `/input/form` is what the
  trade looks like at a call site.
- **`--spacing-input-*` is its own scale**, matching `--spacing-button-*` in
  value and not in name — this is the case [Sizing](../../../AGENTS.md#sizing)
  anticipated. A token test asserts the two stay level, so either can be retuned
  without silently dragging the other along.

## Joining a Button.Group

A field can sit inside a [`Button.Group`](../button/AGENTS.md#buttongroup) and
join the run, so `<Button.Group><Input /><Button>Go</Button></Button.Group>`
reads as one control rather than two boxes touching.

- **A joined field draws the *group's* corner, not its own.** Alone it takes the
  generic ramp — `rounded-lg`, stepping down to `rounded-md` at `sm` — because a
  field and the button beside it are meant to be retunable apart, which is the
  same reason `--spacing-input-*` exists rather than the field reading
  `h-button-md`. In a group that independence is exactly wrong: a run capped by
  a field at one end and a button at the other would draw two different arcs.
  The group owns the shape of its run, so a joined field switches to
  `--radius-button-*`. `input.variants.test.ts` asserts the two emit identical
  corner classes cell for cell, so the copies cannot drift.
- **A field nested in an `Input.Group` never consults the member axes.** That
  row owns the box, and `resolveInputFieldClass` already drops the `root` slot
  entirely when the field is grouped — so the corner and the seam land on the
  row, once, exactly as they land on a lone field. The two are threaded through
  the same `InputBoxState` for that reason: one struct, one box, wherever it
  ends up.
- **`size` comes from the enclosing group outright; `isDisabled` stays a
  fallback.** Controls of different heights do not join, so the group's size
  wins. Disabled is the outermost rung of an already-three-deep ladder
  (`Input.Group` → own prop → `Field` → `Button.Group`), so a single field in a
  run can still be the only one disabled.
