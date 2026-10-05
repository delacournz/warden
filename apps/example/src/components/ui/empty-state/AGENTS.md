# EmptyState

A placeholder for a list or a screen with nothing in it yet. Compound root plus
five parts: `Header`, `Media`, `Title`, `Description`, `Content`.

`import { EmptyState } from "@/components/ui/empty-state";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/empty-state` |
| `empty-state.tsx` | Root + the `Object.assign` compound surface |
| `empty-state-header.tsx` | `EmptyState.Header` |
| `empty-state-media.tsx` | `EmptyState.Media`, and the icon cascade it owns |
| `empty-state-title.tsx` | `EmptyState.Title` |
| `empty-state-description.tsx` | `EmptyState.Description` |
| `empty-state-content.tsx` | `EmptyState.Content` |
| `empty-state.context.tsx` | `EmptyStateProvider`, `useEmptyState()`, `useEmptyStateContext()`, `useEmptyStatePart()` |
| `empty-state.types.ts` | Prop types shared by two or more parts |
| `empty-state.variants.ts` | Pure `tv()` slots and the media colour map, no RN imports |
| `empty-state.variants.test.ts` | |

## Anatomy

```tsx
<EmptyState>
  <EmptyState.Header>
    <EmptyState.Media variant="icon">
      <Icon icon={IconInbox} />
    </EmptyState.Media>
    <EmptyState.Title>No messages</EmptyState.Title>
    <EmptyState.Description>New conversations will show up here.</EmptyState.Description>
  </EmptyState.Header>
  <EmptyState.Content>
    <Button onPress={compose}>New message</Button>
  </EmptyState.Content>
</EmptyState>
```

## Design

- **Variants**: `default`, `card`. **Sizes**: `sm`, `md`, `lg`. **Media
  variants**: `default`, `icon`. Size drives the padding, both gaps, the media
  box, the glyph inside it and both type scales — one axis rather than seven
  numbers that drift apart. The tests assert every one of them ascends.
- **`default` grows; it never uses `flex-1`.** `flex-1` is a zero flex basis, so
  inside a `ScrollView`'s content container, which has no height to grow into,
  the block collapsed to nothing. `grow` keeps the content height as a floor and
  fills whatever spare height a bounded parent has — which is what "fills its
  container" has to mean in both places. A test holds the class.
- **`card` is dashed.** A dashed outline is the conventional mark of a slot
  waiting for content, and it stops an embedded empty state reading as one
  more populated card beside real ones. The corner is the card step,
  `rounded-lg`, stepping to `rounded-md` at `sm` like `ListGroup` and
  `Accordion`. The border is reserved on both variants (`border-transparent` on
  `default`), so switching variant changes a colour and never the layout.
- **A size is padding, never a height.** The description respects OS font
  scaling; a fixed height would clip it at a large accessibility step.
- **Icons are composed, never passed as props.** `Media` wraps its subtree in an
  `IconDefaultsProvider` carrying the `mediaIcon` slot — a step on the shared
  `--spacing-icon-*` scale — and `EMPTY_STATE_MEDIA_FOREGROUND_TOKEN[variant]`.
  A bare glyph is `muted-foreground`, because the picture is decoration and must
  not outweigh the title. Inside the tinted `icon` box it takes `foreground`:
  `muted-foreground` on `bg-muted` is two greys a step apart.
- **The glyph uses the same three steps inside the box and out of it.** The
  icon scale tops out at `icon-2xl`, so a bare glyph one step larger than the
  boxed one would have left `md` and `lg` identical.
- **The media sits further from the title than the title from its
  description.** The header's `gap` spaces the two lines; the media adds a
  bottom margin on top of it, so text reads as one unit and the picture as
  something above it.
- **`Media` is hidden from assistive technology by default.** The title already
  says what the picture shows, and a screen reader saying "image" first only
  delays it. Media that carries meaning of its own opts back in with
  `accessibilityElementsHidden={false}` and `importantForAccessibility="auto"` —
  both are spread after the defaults.
- **`Title` is announced as a header.** An empty screen's title is what the
  screen *is*, and the heading rotor should land on it.
- **Actions are a wrapping row, not a column.** Two actions sit side by side and
  fall to a second line only when they must. `className="flex-col"` stacks them.
  Button size is the caller's choice — `Content` sets nothing on its children, so
  a `Button` keeps every prop it already has.
- **Header and content cap at `max-w-sm`.** On a tablet or in landscape a
  description stretched edge to edge is a line too long to read.
- **Colour goes on the text parts.** No `View` slot carries a `text-*` utility;
  a React Native `View` cannot cascade colour to a `Text`. The tests assert it.
- **No state of its own.** An empty state is a presentation of *someone else's*
  state — a list's length, a query's result. Loading and disabled belong to the
  `Button`s inside it, which already have them.
