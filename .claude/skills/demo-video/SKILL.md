---
name: demo-video
description: Make a short product demo video of warden (or the example app) driven on a real simulator, with a typing terminal beside the phone. Use when asked for a demo video, a feature clip for the docs or X, a re-record after a UI change, or to add/edit a `*.demo.ts` definition. Covers the definition format, `bun run demo`, the record -> contact sheet -> render loop, honesty rules, X export specs and docs embedding.
---

# demo-video

`bun run demo <name>` records a take on a leased iOS simulator, then renders a 1920x1080 video: title left, a terminal that types each real `warden` command and prints its output when the step ends, the phone right (rounded, 3px ring). Kit: `scripts/demo/` (`demo.ts` CLI, `record.ts`, `render.py`, `timeline.ts`, `demo.types.ts`). Definitions: `apps/example/demos/<name>.demo.ts`. Internal: no changeset.

## 1. When to make one

- A feature whose effect is visible on screen and happens in seconds (biometrics, alerts, gestures). Not for logs, perf numbers or anything a table shows better.
- After the app UI or a command's behaviour changed: re-record, never edit the mp4.
- One story per clip, 10-25 s, 3-6 captioned steps.

Needs `ffmpeg`, `ffprobe`, `uv` (`brew install ffmpeg uv`), Xcode, and the fonts in `node_modules/@expo-google-fonts` (`bun install`).

## 2. Write a definition

Export `demo: DemoDefinition` (`scripts/demo/demo.types.ts`). Copy `apps/example/demos/biometrics-faceid.demo.ts`.

| Field | Meaning |
|---|---|
| `title` / `subtitle` / `terminalTitle` / `footer` | static text; title is the claim, subtitle one line |
| `claim` | `{ biometrics?, profile? }` -> `warden claim ios --json --label demo-<name> [--biometrics]` |
| `app` | `bundleId`, `kind` (`simulator` default), `project` (repo-relative cwd), `deepLink` opened with `--settle` |
| `ready` | `warden ui wait` selectors that must pass after the deep link and before the video starts (e.g. `id=bio-screen`); a step never presses a screen that has not mounted |
| `leadInMs` / `tailHoldMs` | idle before step 1 / last frame hold, padded by the renderer (the take tail is 1 s) |
| `steps[]` | `argv` (after `warden`; recorder appends `--udid`), `output` (`ok` draws a vector check, `plain` is muted), `pauseAfterMs`, `shown?`, `hidden?` |
| `outro` | `# comment` line typed after the last output |

Times are never written by hand: the recorder measures each step's start and end against the video clock and the output line appears at the step's END.

## 3. The loop

```bash
bun run demo <name> --record-only      # claim, 9:41 status bar, launch, record, release by id
bun run demo <name> --render-only --sheet   # build mp4 + jpg, write <work>/sheet.jpg
bun run demo <name>                    # both
```

Work dir: `$TMPDIR/warden-demo/<name>` (`--out dir`): `take.mp4`, `steps.json`, `plan.json`, `sheet.jpg`; on a failed take `failure-snapshot.txt` (error + `ui snapshot -i`). Nothing there is committed.

1. Record.
2. Read `sheet.jpg` (4x4 tiles, 1 per second, pts burned in). Check against the log: each output line lands when the phone visibly reacts; no frame shows an unrelated alert, keyboard, red box or wrong status bar; the last frame shows the end state.
3. For a closer look: `ffmpeg -ss 7 -i take.mp4 -frames:v 1 f.png` and `Read` it.
4. Fix in the definition (`pauseAfterMs`, drop/hide a step, `shown`) and `--render-only`; re-record only when the take itself was wrong. Batch fixes: one record per round.
5. Commit the mp4 + jpg in `apps/docs/public/demos/`.

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
- JetBrains Mono has no check glyph: `render.py` draws it as vectors.
- Terminal overflow: `computeTerminalLayout` shrinks pitch and font to 17 px, then scrolls the oldest entries away.
- Device video limit 3 min; keep takes under 40 s anyway.
- Status bar: `xcrun simctl status_bar <udid> override` is allowed on a leased udid; the recorder clears it afterwards.

## 6. X export

1920x1080, H.264 High, yuv420p, 30 fps, `+faststart`, no audio, <= 2:20, small file (kit aims <= 2 MB via a CRF ladder 24..36). Check:

```bash
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate -show_entries format=duration,size apps/docs/public/demos/<name>.mp4
```

## 7. Assets and docs embed

Output: `apps/docs/public/demos/<name>.mp4` + `<name>.jpg` (poster = last frame), served at `/demos/<name>.mp4` (Vite `public/`). No MDX video component exists; use plain HTML in the page:

```mdx
<video controls muted playsInline preload="metadata" poster="/demos/<name>.jpg" className="w-full rounded-lg">
  <source src="/demos/<name>.mp4" type="video/mp4" />
</video>
```

Add a caption sentence naming the commands. The landing page's `apps/docs/public/demo/` is a different pipeline (`bun run demo:compose`).
