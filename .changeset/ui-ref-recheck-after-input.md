---
"@delacour/warden": patch
---

- `warden ui press` / `fill` / `gesture` on an `@eN` taken before another input (a fill that brought the keyboard up, a press, a scroll) re-check the ref first and act on its current frame, instead of tapping where it used to be (which could type a key on the keyboard). On iOS an unmoved ref costs one hit-test (~10 ms); a ref that is gone, now matches more or fewer elements, or sits under the keyboard fails with `stale_ref` (exit 4) and nothing is tapped.
