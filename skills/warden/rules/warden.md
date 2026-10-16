# Mobile devices: warden only

argent, agent-device and tester.army `e2e` / `@e2e-dev/mobile` are retired. Never call their MCP tools, CLIs or skills, even if they are installed. Load the `warden` skill before the first device command.

- **Claim first.** `warden claim ios|android --json` → pass the returned udid/serial on every call. Never pick from `simctl list` / `adb devices`; never touch a booted device you did not claim. Nothing intercepts simctl/adb for you.
- **Hand-driving = `warden ui`** (`open` → `snapshot -i` → `press`/`fill`/`scroll` → `wait`/`is`/`get` → `close --release`). A screenshot is not verification.
- **Saved tests = `*.e2e.ts` specs** with `@delacour/warden-e2e`, run by `warden e2e <suite>` (or `bun test --preload @delacour/warden-e2e/preload` by hand). Never start Metro or export `WARDEN_*` by hand for a suite; `warden dev ios --json` for a dev client.
- **Evidence** = `screen-at-failure.txt` / `results.jsonl` / `e2e-report.json` under the batch dir, then logs. Fix a missing testID in the component (`accessible`), not with retries.
- **Release.** `warden ui close --release` or `warden release <leaseId> [--shutdown]`. A bare claim lasts 5 min. Subagents never run bare `warden release --mine`: release by id, or `--mine --label <x>`.
