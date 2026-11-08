---
"@delacour/warden": minor
---

- The on-screen keyboard now shows by default on every warden-leased iOS simulator and Android emulator, even while warden types with hardware key events. `hardware` mode hides it, as with a connected keyboard. Release puts the default back.
- `warden ui keyboard software|hardware|toggle|status|reset` switches the mode live, so you can watch a bottom sheet or footer ride the keyboard. `status` prints the mode and whether a keyboard is showing. `warden ui status` lists a non-default mode.
- Specs: `device.keyboard("software" | "hardware" | "toggle")`, `device.keyboardVisible()` and `expect(device).toHaveKeyboard()` / `.not.toHaveKeyboard()`. Suite config: `conditions: { keyboard: "hardware" }`.
- iOS: a tap on a target under the keyboard scrolls it clear, or closes the keyboard without pressing Return, so a form is never submitted by accident. `device.hideKeyboard()` closes it the same way.
- Android `hardware` mode turns the input methods off and `software` restores them exactly. Physical devices answer `E_UNSUPPORTED` to a mode change.
