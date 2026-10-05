# Avatar

A person, as a picture — with an initials fallback, an overlay slot for a count
or a presence dot, and a group that stacks several faces and counts the rest.
Compound root plus `Avatar.Badge` and `Avatar.Group`.

`import { Avatar } from "@/components/ui/avatar";`

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | → `@/components/ui/avatar` |
| `avatar.tsx` | Root + the `Object.assign` compound surface |
| `avatar-badge.tsx` | `Avatar.Badge` — the corner overlay, a presence dot when empty |
| `avatar-group.tsx` | `Avatar.Group`, plus its internal `Item` and `Overflow` leaves |
| `avatar.context.tsx` | `AvatarProvider`, `AvatarGroupProvider`, `useAvatar()`, `useAvatarContext()`, `useAvatarGroupContext()`, `useAvatarPart()` |
| `avatar.variants.ts` | Pure `tv()` slots, `AVATAR_SIZE_POINTS`, `resolveAvatarSize`, `resolveAvatarOverlap`, `resolveAvatarInteractive` |
| `avatar.variants.test.ts` | |
| `avatar.utils.ts` | Pure non-styling logic — initials, the image-retry key, group overflow maths, the spoken label |
| `avatar.utils.test.ts` | |

## Design

- **The fallback is always painted; the image goes on top.** The face renders
  its initials (or a person glyph) first and mounts the `Image` absolutely over
  them. A picture that is still loading, or that never loads, leaves the fallback
  showing rather than an empty circle — there is no loading state to manage
  because there is nothing to swap.
- **A failure is remembered by key, not by object.** `resolveAvatarSourceKey`
  turns the source into a string — URI plus sorted headers, or the asset's module
  id — and `onError` stores the key that failed. Keyed by object identity, an
  inline `source={{ uri }}` is new every render and a dead URL would retry
  forever; keyed by URI alone, a token refresh in the headers would never retry.
  A consumer's `imageProps.onError` fires after the fallback has taken over.
- **The root carries the edge; there is no `self-start`.** A fixed width and
  height is something a column's `stretch` never overrides, so the avatar keeps
  its size without the `self-start` a [`Badge`](../badge/AGENTS.md) needs — and
  it leaves the parent's alignment alone. With `self-start`, every avatar in an
  `items-end` or `items-center` row was pinned to the row's top: mixed sizes lost
  their baseline and a list row's avatar sat above its title. Found on the
  simulator; a test now forbids any `self-*` on the root or the group.
- **Two boxes, not one.** `root` is unclipped and holds the overlays; `face` is
  the clipped circle. An `Avatar.Badge` hangs over the circle's edge, and a
  single clipped box would cut it in half. A test asserts `overflow-hidden` is on
  `face` and never on `root`.
- **Initials are the first letter of the first and last word.** `Mary Jane
  Watson` is `MW`, the way a person signs, and `Cher` is `C`.
  `resolveAvatarInitials` walks code points rather than UTF-16 units, so a letter
  outside the basic plane is never split into a replacement box, and skips
  leading punctuation so `"(Kate)"` still gives `K`. `fallback` overrides the
  drawn text only; `name` is still what a screen reader reads.
- **Two axes paint the fallback, on `Badge`'s six colours.** `variant` is `soft`
  or `solid`, `color` is `default` … `info`, and the twelve cells live in
  `compoundVariants` with the same fills `Badge` uses, so an avatar and a badge
  of one colour read as one family. `AVATAR_FOREGROUND_TOKEN` gives the person
  glyph the same shade as the initials; a test pins each entry to the token the
  `fallbackLabel` slot resolves to, and checks every token exists in both themes.
- **A neutral face has a hairline edge; a photo does not.** `muted` and
  `secondary` sit a percent or two from the page in light — on the simulator a
  `default` fallback and the `+N` tile all but vanished. They draw
  `border-border` inside the box, so nothing moves, and the edge goes while a
  photo is mounted (`hasImage`), since a grey line around a face reads as a
  frame. The coloured fallbacks have fill enough without one.
- **A size is a fixed edge, unlike a badge.** `sm`/`md`/`lg`/`xl` are
  32/40/48/64 points. Faces line up against each other and against list rows, and
  a circle that grew with OS font scaling would break the stack; the initials
  therefore set `allowFontScaling={false}` and are sized to fit the smallest
  step. `AVATAR_SIZE_POINTS` restates the scale as numbers because the group's
  overlap is a runtime margin and cannot be a class; a test pins the two
  together.
- **An avatar is content until it is given something to do** — the rule
  [`Badge`](../badge/AGENTS.md) follows. With no `onPress` or `onLongPress` it
  is a plain `View` announced as an image (or not announced at all when it has
  no name); supply either and it becomes a [`Pressable`](../pressable/AGENTS.md)
  announced as a button. `resolveAvatarInteractive` is that decision.
- **The avatar is one element to assistive technology.** The root is
  `accessible`, so an `Avatar.Badge` inside it is never focused on its own. A
  presence dot has no words; put the status into the avatar's
  `accessibilityLabel` (`"Kate Austen, online"`).
- **`Avatar.Badge` is a pin, and a dot only when empty.** Given children — a
  `Badge` with a count, an `Icon` — it positions them and adds nothing else, so a
  count keeps the look it has everywhere else. Empty, it draws a dot sized to
  the face and ringed in `border-background`, which separates it from the photo
  underneath. `placement` is `top-right` or `bottom-right`.
- **The group's ring belongs to the slot, not the face.** Each child is wrapped
  in an item with `border-2 border-background`, so a face in a group keeps the
  same edge it has alone, and the stack reads as separate people on any surface.
  The `+N` tile sits in the same wrapper, so it lines up with the faces.
- **The first face is on top, and the list still reads first to last.**
  `zIndex` counts down across the items instead of the children being reversed,
  and the overlap is a negative `marginStart`, so the order in the tree — and
  therefore the order a screen reader walks — is the written order in both
  writing directions. The group is `role="list"` and each item `listitem`.
- **`max` caps the faces, not the row; `total` counts people never passed.**
  Five children at `max={3}` is three faces and `+2`; three children with
  `total={40}` is `+37`, without forty elements in the tree.
  `resolveAvatarGroup` clamps a negative or fractional `max` and ignores a
  `total` below the child count rather than drawing `+-2`.
- **The overflow tile draws at most `99+` and reads the real number.** Three
  digits do not fit a small circle; a screen reader has room for `1234 more`.
  `onOverflowPress` turns the tile into a button — to open the full list.
- **The overlap defaults to a third of the edge and is clamped.**
  `resolveAvatarOverlap` never slides a face further than a whole face nor
  backwards, and `overlap={0}` closes the stack into a plain row. A child's own
  `size` still beats the group's, but the overlap is computed from the group's.
