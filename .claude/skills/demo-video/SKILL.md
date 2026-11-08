---
name: demo-video
description: Make a short product demo video of warden (or the example app) driven on a real simulator, with a typing terminal beside the phone. Use when asked for a demo video, a feature clip for the docs or X, a re-record after a UI change, or to add/edit a `*.demo.ts` definition. Covers the definition format, `bun run demo`, the record -> contact sheet -> render loop, honesty rules, X export specs and docs embedding.
---

# demo-video

`bun run demo <feature>/<clip>` records a take on a leased iOS simulator, then renders a 1920x1080 video: title left, a terminal that types each real `warden` command and prints its output when the step ends, the phone right (rounded, 3px ring). Kit: `scripts/demo/` (`demo.ts` CLI, `record.ts`, `render.py`, `timeline.ts`, `demo.types.ts`). Definitions: `apps/example/demos/<feature>/<clip>.demo.ts` (`name` must equal `<feature>/<clip>`); assets: `apps/docs/public/demos/<feature>/<clip>.mp4|jpg`. One folder per feature (`biometrics`, `network`, `location`, `clock`), lower-case, hyphens. Internal: no changeset.

## 1. When to make one

- A feature whose effect is visible on screen and happens in seconds (biometrics, alerts, gestures). Not for logs, perf numbers or anything a table shows better.
- After the app UI or a command's behaviour changed: re-record, never edit the mp4.
- One story per clip, 10-25 s, 3-6 captioned steps.

Needs `ffmpeg`, `ffprobe`, `uv` (`brew install ffmpeg uv`), Xcode, and the fonts in `node_modules/@expo-google-fonts` (`bun install`).

## 2. Write a definition

Export `demo: DemoDefinition` (`scripts/demo/demo.types.ts`). Copy `apps/example/demos/biometrics/faceid.demo.ts`.

| Field | Meaning |
|---|---|
| `title` / `subtitle` / `terminalTitle` / `footer` | static text; title is the claim, subtitle one line |
| `phoneCaption` | line under the phone, default `real simulator · not an animation`; `""` hides it |
| `claim` | `{ biometrics?, profile? }` -> `warden claim ios --json --label demo-<feature>-<clip> --ttl 30m [--biometrics]` |
| `app` | `bundleId`, `kind` (`simulator` default), `project` (repo-relative cwd), `deepLink` opened with `--settle`, `appearance` (`light`/`dark`, set via `simctl ui` on the leased udid, restored after) |
| `setup` | `warden` argv run off camera after the app opens, before the deep link; `["ui","network","set","online","--relaunch"]` gives the iOS dylib launch network / clock steps need. An entry is an argv or `{ argv, optional: true }`: an optional step that exits non-zero is logged (`optional setup warden … -> <code>`) instead of failing the take (a permission prompt that may not show) |
| `ready` | `warden ui wait` selectors that must pass after the deep link and before the video starts (e.g. `id=bio-screen`); a step never presses a screen that has not mounted |
| `leadInMs` / `tailHoldMs` | idle before step 1 / last frame hold, padded by the renderer (the take tail is 1 s) |
| `steps[]` | `argv` (after `warden`; recorder appends `--udid`), `output` (`ok` draws a vector check, `plain` is muted, `lines` prints several muted lines), `pauseAfterMs`, `shown?`, `hidden?`, `quote?` |
| `outro` | `# comment` line typed after the last output |

`output: { kind: "lines", text: [...] }` prints one muted line per entry (keep to about 6; each past the first costs 0.4 of an entry pitch in the layout) for code or text shown from a file. Pair it with `quote: { file }` (path relative to `app.project`): after the step the recorder checks that every printed line, trimmed, occurs in that file and throws `quoted line not in <file>: <line>` otherwise, so a quoted line is never invented. Lines still go through `maskSecrets`.

Times are never written by hand: the recorder measures each step's start and end against the video clock and the output line appears at the step's END.

## 3. The loop

```bash
bun run demo <feature>/<clip> --record-only      # claim, 9:41 status bar, launch, record, release by id
bun run demo <feature>/<clip> --render-only --sheet   # build mp4 + jpg, write <work>/sheet.jpg
bun run demo <feature>/<clip>          # both
```

Work dir: `$TMPDIR/warden-demo/<feature>/<clip>` (`--out dir`): `take.mp4`, `steps.json`, `plan.json`, `sheet.jpg`; on a failed take `failure-snapshot.txt` (error + `ui snapshot -i`). Nothing there is committed.

1. Record.
2. Read `sheet.jpg` (4x4 tiles, 1 per second, pts burned in). Check against the log: each output line lands when the phone visibly reacts; no frame shows an unrelated alert, keyboard, red box or wrong status bar; the last frame shows the end state.
3. For a closer look: `ffmpeg -ss 7 -i take.mp4 -frames:v 1 f.png` and `Read` it.
4. Fix in the definition (`pauseAfterMs`, drop/hide a step, `shown`) and `--render-only`; re-record only when the take itself was wrong. Batch fixes: one record per round.
5. Commit the mp4 + jpg in `apps/docs/public/demos/<feature>/`.

## 4. Honesty rules

- Every printed command ran, against the real app. No `shown` that differs in meaning from `argv` (it only trims flags such as `--timeout`).
- Output text is what the phone did, not what the command printed. If a press has no visible effect (dropped during a sheet's entrance animation, nothing changed), do not caption it: `hidden: true`, or fix the timing with a longer previous `pauseAfterMs`.
- First-run permission alerts show only on a fresh install; the claim reuses a warm build, so do not caption an alert unless the take shows it.
- No app-side bypass or mocked prompt: the claim in the title must be true on the take.
- Secrets: `maskSecrets` hides key=value, `ghp_`/`sk-` style tokens and long hex/base64 in printed lines. Still check the phone for tokens, emails, device names.
- Real simulator, real iOS UI. Never composite fake frames.

## 5. Gotchas (encoded in the kit)

- simctl video is VFR and drops the idle tail: the renderer `fps`-normalises and pads the last frame (`tpad`) to the plan length.
- Video time matches the command log within ~0.5 s; the recorder starts the clock right after `video start`.
- Martian Mono has no check glyph: `render.py` draws it as vectors.
- The frame is the docs Device Hub dark palette (Mona Sans + Martian Mono); set `app.appearance: "dark"` so the phone matches. The recorder restores the sim's appearance afterwards.
- Terminal overflow: `computeTerminalLayout` shrinks pitch and font to 17 px, then scrolls the oldest entries away.
- Device video limit 3 min; keep takes under 40 s anyway.
- Status bar: `xcrun simctl status_bar <udid> override` is allowed on a leased udid; the recorder clears it afterwards.

## 6. X export

1920x1080, H.264 High, yuv420p, 30 fps, `+faststart`, no audio, <= 2:20, small file (kit aims <= 2 MB via a CRF ladder 24..36). Check:

```bash
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate -show_entries format=duration,size apps/docs/public/demos/<feature>/<clip>.mp4
```

## 7. Assets and docs embed

Output: `apps/docs/public/demos/<feature>/<clip>.mp4` + `<clip>.jpg` (poster = last frame), served at `/demos/<feature>/<clip>.mp4` (Vite `public/`). Embed with the `DemoClip` MDX component (`apps/docs/src/components/demo-clip.tsx`): autoplays muted and loops, rests on the poster under reduced motion. `src` has no extension; `label` says what the clip shows (match the caption). A raw `<video>` fails `apps/docs/src/lib/source.test.ts`.

```mdx
<DemoClip src="/demos/<feature>/<clip>" label="warden ui … doing … on a leased simulator" />
```

Add a caption sentence naming the commands. The batch reel `apps/docs/public/demos/e2e/batch.*` (embedded with `<DemoReel>`) is a different pipeline (`bun run demo:compose`).

## 8. The `warden dev` reel (`dev/hero`)

A third pipeline: warden's REAL dev dashboard (left, in a terminal card) beside the simulator `warden dev` claims itself (right). Nothing is typed or faked: `dev-take.ts` spawns `warden dev ios --label demo-dev-<clip> --headless --no-shutdown` in a PTY (`Bun.spawn({ terminal })`) mirrored into `@xterm/headless` (frame reads for the waits) and writes every PTY chunk to `tui.cast`; the clock origin is the spawn. It polls `warden ls --json` for the labelled device lease, then sets dark + 9:41, uninstalls the app and starts `ui screen video` (the phone is black until then). The dev child gets its own `WARDEN_SESSION_ID`: `warden dev` adopts a device lease held by the caller's session, and every teammate agent shares one, so without it the take could drive someone else's simulator.

```bash
bun run demo:dev dev/hero --record-only        # claim, uninstall app, 9:41 + dark, record, release by id
bun run demo:dev dev/hero --render-only --sheet # agg + ffmpeg -> apps/docs/public/demos/dev/hero.{mp4,webm,jpg}, <work>/sheet.jpg
bun run demo:dev dev/hero                      # both
```

- Kit: `dev-demo.ts` (CLI), `dev-take.ts` (recorder, `runBeats`), `dev-render.ts` (agg + compose, `DEV_LAYOUT`), `dev-frame.py` (card, ring, mask), `dev-timeline.ts` (cast text, ramp segments, captions). Types: `DevDemoDefinition` / `DevBeat` in `demo.types.ts`. Definition: `apps/example/demos/dev/<clip>.demo.ts`; work dir `$TMPDIR/warden-demo/dev/<clip>` (`take.mp4`, `tui.cast`, `dev.json`, `sheet.jpg`, `failure-frame.txt`).
- A beat = `waitScreen` (regex over the TUI frame) + `waitPhone` (`ui wait` selectors) -> action (`keys` into the TUI, and/or a real `edit` of a repo file) -> `afterPhone` selectors (the hot reload landing) -> `pauseAfterMs`. `dev.json` holds each beat's start / ready / end on the video clock; captions run from a beat's action to the next one's.
- The edit is a real source edit (`welcome.tsx` body string), reverted byte for byte in `finally`; check `git diff apps/example/src` is empty after a take.
- `uninstallFirst` removes the app from the leased sim so `warden dev` installs the dev build from the cache on camera. The FIRST take on a fingerprint is a local build (minutes, `dev build` row compiles): record once to warm the cache, then re-record. `warden app ensure --kind dev` does not warm the cache `warden dev` reads.
- Speed ramps: `DevBeat.ramp: N` speeds up that beat's wait by N (keeping 1.2 s head and 1 s tail at real speed) and the reel draws a `× N speed` tag. A warm take that is slow in the dev client wait ramps it. Keys and the hot reload are always real time.
- Honesty: facts in the `<DemoReel>` caption come from the take's TUI rows (`dev build 3.5s`, `Metro 3.9s`, `dev client 161ms`) and `dev.json` (edit -> `ui wait` sees the new text: 0.76 s). Re-read them after every re-record; they change.
- Limits: the dashboard has no separate claim row (it is inside `preparing the ios dev build`); `--headless` so no Device Hub window opens; 100x26 PTY (100 cols is the HUD's minimum). A beat with `stopVideoFirst` stops the video before its action (`q` ends the lease and `warden ui` then refuses). After `q` the take verifies `warden ls` holds no lease of the session (fails otherwise), and the cast is cut where the dashboard leaves the alt screen so the reel ends on its last frame. The dev launcher's white loading screen and the blue `Refreshing…` banner are the real app; a Metro reload can also come from another agent editing `apps/example/src`.
- Ramps: `ramp` only applies when the wait, minus its 1.2 s head and 1 s tail, is at least 6 s (`RAMP_MIN_S`). The hero ramps its dev client wait 3x with a tag.
- `devEnv` adds env to the `warden dev` child; the hero sets `EXPO_NO_DEPENDENCY_VALIDATION=1` (`@expo/cli` `checkDependenciesOnStart`) to drop Expo's "update available" nag from the Metro pane. Use it only for noise, never behaviour.
- Embed with `<DemoReel src="/demos/dev/hero" command="warden dev ios" facts="…" label="…" />` (landing hero, `sims/dev.mdx`, `getting-started/quickstart.mdx`). Poster = the `posterBeat` action frame + 1 s (HUD on, all rows done, app running).

## 9. Terminal-heavy clips (VID-6)

All real commands; every reel shows only what ran. One clip at a time, release by label after each.

| Clip | Pipeline | Command |
|---|---|---|
| `e2e/parallel` | `batch-take.ts`: `warden e2e <suite> --count N --record --headless` into `<work>/rec`, styling each leased sim dark + 9:41 as it boots, then `compose.ts --height 1080` | `bun run demo:batch e2e/parallel --suite example --specs devtools,gestures,onboarding,sign-in,todo-detail --count 2` (`--record-only` / `--compose-only`; header shows spec count; counter reads `N/total shards done` when specs differ from jobs) |
| `dev/worktrees` | `LanesDemoDefinition`: one `recordDev` per lane concurrently, a shell strip (`warden ls`) below | `bun run demo:lanes dev/worktrees` (`lanes.ts`, `lanes-frame.py`, `lanes-demo.ts`; lanes share one clock via `DevTake.startedAtS`) |
| `golden/clone` | `DevDemoDefinition.script`: a shell script runs in the PTY instead of `warden dev` | `bun run demo:dev golden/clone` |
| `debug/failure` | `script` + `rawVideo` | `bun run demo:dev debug/failure --sheet` |

- `script` mode: no uninstall, no release check; the take ends with `release --mine --label L --shutdown` and `sims delete <udid> --yes`. A beat with `waitBoot` polls `simctl io screenshot` until the PNG exceeds 100 KB (`HOME_SCREEN_MIN_BYTES`): a freshly cloned headless sim shows the Apple logo 10+ s after `claim` returns. Ramp that wait (3x, with tag).
- `rawVideo`: records with `simctl io recordVideo` (SIGINT to stop) because warden's `ui screen video` helper conflicts with `warden e2e` on one device.
- `--record` only records devices present at start; elastic late joiners have no video. The host capacity gate sets how many fit, so ask for no more sims than are booted at start (max 2 here).
- Throwaway spec for `debug/failure` is written to `apps/example/e2e/debug-demo.e2e.ts` and removed by a shell trap; check `git status` after (a killed take can leave it).
- Embed with `<DemoReel src="/demos/<feature>/<clip>" command="…" facts="…" label="…" />`; facts come from the take, re-read after each re-record.
- `demo:batch` styles sims with a poller (`styleWhenBooted`: `warden ls --json` for the label, `simctl list` for Booted, then `ui appearance dark` + `status_bar override 9:41`) because `warden e2e` has no per-device hook; it releases `--mine --label demo-<feature>-<clip> --shutdown` in `finally`. Use specs that pass on a clean sim (`perf`, `settings`, `todos` do not reliably); the compose `--height 1080` flag gives the 16:9 layout (terminal card left, phones right). Lanes reels (`dev/worktrees`) are 1920x1080 by construction.
