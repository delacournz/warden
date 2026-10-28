---
"@delacour/warden": patch
---

- `warden e2e` specs on a dev client (`WARDEN_METRO_URL`) run with React Native's LogBox off: no warning/error toasts and no error inspector cover the app or take taps, fatals included, after every relaunch and JS reload too. Logs still reach `console.jsonl` and Metro's terminal.
