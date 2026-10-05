# Textarea

A multiline text field, sized in rows. One component, no parts: it renders an
[`Input`](../input/AGENTS.md) and adds a height and an optional character count.

`import { Textarea } from "@/components/ui/textarea";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/textarea` |
| `textarea.tsx` | `Textarea` |
| `textarea.variants.ts` | Pure `tv()` slots, the line metrics and the height and count resolvers, no RN imports |
| `textarea.variants.test.ts` | |

## Design

- **The box is `Input`'s, and nothing here restates it.** Variants (`primary`,
  `secondary`), sizes (`sm`, `md`, `lg`), the focus ring, the invalid border
  that outranks it, the disabled fade, the `accent-*` caret and placeholder, and
  the `Field` cascade all come from rendering an `Input` with `multiline`. A
  second `tv()` for the same border would be a second thing that can drift, and
  a textarea under a row of single-line fields has to read as the same control
  at a different height — not as a close match.
- **`rows` is a line count, and it becomes points in JavaScript.** A row count
  only turns into a height once the height of a line is a number, so
  `TEXTAREA_LINE_HEIGHTS` holds it per size and `resolveTextareaRowsHeight` adds
  the padding and the border either side. The result is a **style**, never a
  class: a runtime `` `h-[${n}px]` `` is never compiled by Tailwind's static
  scanner and would draw nothing — the rule in
  [Sizing](../../../AGENTS.md#sizing). `size` moves the type and the leading, so
  a small three-row field and a large one are both three rows.
- **Every number the height counts is pinned to the class that draws it.** The
  line height is set by a `leading-*` class in `textareaVariants`' `field` slot,
  and the padding is `Input`'s multiline `py-*`. `textarea.variants.test.ts`
  resolves both classes and fails if either disagrees with its number — a
  retune of `Input`'s padding would otherwise mis-size every textarea by a few
  points, silently, with the last line clipped at the bottom edge.
- **A paragraph gets paragraph leading.** `Input` sets `leading-tight` because
  it centres one line in a fixed box; four lines at 1.25× read as a wall. The
  textarea's `leading-5`/`-6`/`-7` replace it through `Input`'s own className
  merge rather than sitting beside it, and a test holds each between 1.2× and
  1.6× the `--text-input-*` size so the type scale can be retuned without this
  going stale.
- **`autoGrow` measures nothing.** It sets `minHeight` at `rows` and
  `maxHeight` at `maxRows`, and between the two React Native's multiline
  `TextInput` sizes itself to its content; past the cap it scrolls. An
  `onContentSizeChange` loop would draw one frame at the old height after every
  new line, which is exactly the jump a growing field exists to avoid. The field
  never shrinks below `rows`, so a message typed and cleared goes back to where
  it started rather than collapsing to one line.
- **`maxRows` only type-checks with `autoGrow`, and `showCount` only with
  `maxLength`.** Both are unions in `TextareaProps`. A ceiling on a field that
  does not grow is a number nothing reads, and a count with no limit to count
  towards says nothing — a runtime warning would only find either out on a
  device.
- **A bad row count degrades rather than throws.** `resolveTextareaRows` floors
  to whole lines, clamps to at least one, falls back on `NaN` or `Infinity`, and
  lifts a `maxRows` below `rows` up to it — otherwise a growing field would
  shrink as it grew.
- **The count turns destructive at the limit, not past it.** Native `maxLength`
  stops typing at the limit, so "over" is a state someone typing never sees;
  the count has to change at the moment the keyboard stops working. It renders
  `Text.Caption` and passes its colour through the preset's `color` prop, so the
  `count` slot carries no colour class to fight it. It uses `tabular-nums` so it
  does not jitter as it counts, and announces as "12 of 280 characters" rather
  than as a fraction.
- **The count works controlled and uncontrolled.** A `value` is read directly;
  without one, the last text the field reported is, seeded from `defaultValue`
  so the first frame is already right.
- **There is always a wrapping `View`.** `className` reaches the field, as it
  does on `Input`, and `containerClassName` reaches the wrapper that holds the
  field and its count. The wrapper is there whether or not the count is, so
  flipping `showCount` never remounts the field and drops focus.
- **`multiline` and `numberOfLines` are withheld.** It is always multiline, and
  `rows` is its height; `numberOfLines` would be a second answer to the same
  question, and on Android the one that wins.
- **There is no `label`, `description` or `errorMessage` prop.** A textarea goes
  in a [`Field`](../field/AGENTS.md) the way an `Input` does — the reason
  `Input` ships no label part holds here too. `apps/playground`'s
  `/textarea` gallery ends with a composed form showing the trade at a call site.
- **Not for `Input.Group` or `Button.Group`.** An inner `Input` would read
  either context and take its box or its corner, but a decorated or joined
  paragraph is not a control this library draws, and the height math assumes
  the box is the field's own.
