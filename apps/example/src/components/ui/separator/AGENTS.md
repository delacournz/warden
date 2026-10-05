# Separator

A one-pixel rule, hidden from assistive technology — a line between every row
carries nothing a screen reader can use, and announcing them buries the rows.

`import { Separator } from "@/components/ui/separator";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/separator` |
| `separator.tsx` | The `tv()` and the component, in one file |

## Design

- **`separatorVariants` lives in `separator.tsx`**, above the component, not in a
  `*.variants.ts` sibling — the pattern C carve-out. That file imports React
  Native, so the `tv()` is not reachable from `bun test`; the exclusive-axis and
  `self-stretch` rules below are stated in its doc comment instead of asserted.
- **Orientations**: `horizontal` (default), `vertical`.
- **The long axis is `self-stretch`, never `w-full` / `h-full`.** Yoga resolves
  a percentage length against the parent's content box and then adds the
  margins on top, so an inset `w-full` line starts 16pt in and runs 16pt past
  the far edge — a gap down one side and none down the other. Stretching
  subtracts the margins instead, which is what an inset divider needs. Do not
  "fix" this back to a percentage width.
- **A filled box, not a border**, so a caller insets it with a plain `mx-*`
  without fighting a border's own box model. This is how
  [`ListGroup`](../list-group/AGENTS.md) positions the dividers it inserts.
