---
"@delacour/warden": patch
---

- The Metro that `warden dev` and `warden e2e --dev` start listens on `127.0.0.1` only: `expo start --localhost`, and `react-native start --host 127.0.0.1` for a bare React Native app. Simulators and emulators reach it as before (Android through `adb reverse`). To serve another machine or a phone on your network, pass a host yourself: `warden dev ios -- --lan` (or `--tunnel`, `--host <h>`); warden then adds none.
- `$WARDEN_HOME` is owner-only: created `0700` with `warden.db` (and its `-wal` / `-shm`) `0600`. A home that group or others could reach is tightened on the next run; one owned by another user stops the command with `<home> is owned by uid <n>, not by you`.
- Without `HOME`, the default home is the user's home directory's `.warden`, no longer a `~/.warden` directory under the working directory.
- warden's unix sockets (`warden dev` control and devtools broker, the Android host, the iPhone runner proxy) are created `0600` in a `0700` directory. A socket whose path is too long for `$WARDEN_HOME` now lives in `/tmp/warden-<uid>` (`0700`, yours, never a symbolic link) instead of the shared temp directory.
