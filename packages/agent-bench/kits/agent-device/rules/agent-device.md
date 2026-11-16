# agent-device

Use agent-device only for app/device automation tasks.
For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot.
For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`.
For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, allocation hotspots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use MCP tools or the CLI in the integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the command the same way the user would from a normal terminal session and run that absolute path instead. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`.
Do not silently fall back to `npx -y agent-device@latest`; ask or use an exact version.
MCP exposes structured tools backed by the agent-device client; it does not expose generic shell execution.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where the target supports capture and selectors; otherwise follow target-specific help.
Use current refs such as `@e3` for exploration and selectors for durable replay.
Keep mutating commands against one session serial.
Capture screenshots, logs, network, audio, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.
