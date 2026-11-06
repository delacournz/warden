---
"@delacour/warden": patch
---

- A spec read that fell back from the iOS bridge to host `ax` (or came back as an empty root) no longer counts a missing node as absent: `toBeHidden`, `.not.toBeVisible`, `toHaveCount(0)`, `waitFor({ state: "hidden" | "detached" })` and `isHidden()` keep polling instead of passing vacuously.
- A plain `getByTestId` on such a read asks the React tree first when the app has devtools, and uses its presence and rect.
- New error code `READ_DEGRADED` when nothing could confirm the locator before the timeout; the message names `fellBackFrom` and the read backend.
