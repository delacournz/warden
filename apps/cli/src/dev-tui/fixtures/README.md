# dev-tui fixtures

## expo-start.bin

Raw bytes Expo wrote to its PTY, unmodified except that the project path was rewritten to `/work/example`. Not valid UTF-8 on chunk boundaries: feed it to `@xterm/headless` as a `Uint8Array`, never decode it per chunk.

- Captured: 2026-10-26, `bunx expo start --dev-client --port 8101` in `apps/example`, Expo CLI 57.0.27, Bun 1.4.3, macOS.
- PTY: 60 cols x 20 rows, `TERM=xterm-256color`, `CI` unset, `EXPO_NO_TELEMETRY=1`.
- Script (`apps/cli/scripts/record-expo-fixture.ts`): wait for the menu hint, `?` (full menu), `m` ("Toggling dev menu", no app connected), `r` ("Reloading apps"), then `\x03` (spinner "Stopping server", exit 0). Roughly 12 s, 3890 bytes.
- Contains: dim/bold/underline/16-colour SGR, an OSC 8 hyperlink, the QR code as half-block characters, cursor hide/show, and `\e[2K\e[1A` line erasing from the spinner.

Re-record: `cd apps/cli && bun scripts/record-expo-fixture.ts --port <free port> --out /tmp/expo.bin`, then swap the project path.
