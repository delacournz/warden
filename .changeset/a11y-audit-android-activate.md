---
"@delacour/warden": patch
---

- `missing-name` no longer flags an unclickable scroll container on Android (React Native's ScrollView is focusable but TalkBack never stops on it).
- `label-in-name` ignores punctuation, so a name "Walk dog, Active" contains the visible text "Walk dog Active".
- `device.screenReader.activate()` / `warden ui a11y` activation clicks a node that lists `ACTION_CLICK` even when its clickable flag is off (React Native `activate` actions, a gesture-handler switch), as TalkBack's double tap does.
