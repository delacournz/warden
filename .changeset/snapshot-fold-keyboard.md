---
"@delacour/warden": minor
---

- `warden ui snapshot -i` folds the iOS on-screen keyboard into one line, `@eN [keyboard] return="go" visible (x,y w×h) N keys (--keys)`, instead of ~40 key lines. The ref is the return key's, so `press @eN` presses go/next/return. In `--json` it is one element with `role: "keyboard"`, the return key's `name` and a new optional `keys` count.
- New `--keys` flag on `warden ui snapshot`: with `-i`, lists every key again. A snapshot without `-i` is unchanged.
- `snapshot -i` and spec failure excerpts leave out 0×0 elements that are neither hittable nor carry a testID (the keyboard's `Padding-*` buttons).
