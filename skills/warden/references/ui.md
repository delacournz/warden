# warden ui: drive a leased device by hand

For exploring, reproducing a bug, or finding selectors. Checks that must keep passing belong in a spec (`specs.md`). Every call is stateless on the command line; the last snapshot, recording and Metro URL live under `$WARDEN_HOME/ui/<udid>/`.

## Loop

```bash
warden claim ios --json                       # keep the returned udid (Android: serial)
warden dev ios --json                         # dev client only, in background; already opens the dev client
warden ui open com.example.app --udid $UDID   # launch (dev client: attaches); --metro <url> if you run Metro yourself
warden ui snapshot -i --udid $UDID            # @eN lines
warden ui press @e3 --settle --udid $UDID     # act; --settle prints what changed
warden ui wait id=todos-screen --udid $UDID   # verify with wait / is / get; a screenshot is not verification
warden ui record start add-todo --udid $UDID  # optional
warden ui close --release --udid $UDID
```

## Device resolution (in order)

1. `--udid` / `--serial` / `--lease <id>`
2. `WARDEN_UDID`
3. `WARDEN_UDIDS` with exactly one entry
4. your single device lease. None: exit 2 (`no_device_leased`); `--claim` claims one (label `warden ui`, 30 m). Several: `ambiguous_device`.

Every call heartbeats your lease. Another live session's lease: `device_foreign`. Stale or missing: `device_not_leased` unless `--claim`.

## Dev client

- `warden dev ios --json` already opens the dev client. `open <bundleId>` then only attaches (`attached to <id>`); `--relaunch` restarts it.
- `--metro <url>` launches the dev client on that Metro and remembers it for the devtools commands.
- Android: `open <bundleId>` takes `--metro`/`--args` in the CLI but the driver rejects them. `warden dev android` opens the dev client via `adb reverse` + `exp+<slug>://expo-development-client/?url=...`. By hand, `open <url>` with that deep link.
- `--relaunch`, `--metro`, `--args` apply to a bundle id, not a URL (`usage`).

## Global options (every subcommand)

| Flag | Effect |
|---|---|
| `--udid <id>` `--serial <s>` `--lease <id>` | the device |
| `--claim` | claim a device when none is held, or take over a stale/missing lease |
| `--platform ios\|android` `--profile <slug>` `--runtime <rt>` | choose the device for a `--claim` with none named (default ios) |
| `--timeout <ms>` | per-command deadline (default 5000) |
| `--no-record` | keep this step out of a running recording |
| `--force` | drive the device while your running `warden e2e` / `batch` / `run` / `dev` holds it (else exit 2 `device_busy`); it disturbs that run |
| `--json` | one JSON document on stdout |

Actions also take `--settle [ms]`: wait for a quiet screen (budget 3000 ms), then print what changed.

## Snapshot line and generations

```text
generation 4 · axbridge · 393×852@3x · 5 of 41 elements
@e1 [textbox] "Add a todo" id=todo-input value="" enabled hittable (24,118 345×48)
```

Line: `@eN [role] "name" id=<testID> value="..." <states> (x,y w×h)`. States: `enabled`/`disabled`, `hittable`, `checked`/`unchecked`, `selected`, `focused`, `secure`, `hidden`, `expanded`/`collapsed`.

- `-i` = interactive elements plus anything with a testID. Cap 200 lines (`--all` removes it). `--depth n` = first n levels.
- The generation bumps on `snapshot`, `find`, any `--settle`, a matching `wait`, and `scroll --until`. Older refs then fail: exit 4 `stale_ref`, snapshot again.
- A ref older than 30 s, or any ref with `--verify`, is re-checked against a fresh snapshot (same id, else role + name, else position). Prefer `id=` selectors for anything you touch twice.

## Subcommands

| Command | Args / flags | Notes |
|---|---|---|
| `status` | | device, lease, helper, recording |
| `close` | `[--app [bundleId]] [--release]` | stops this device's helper; `--app` quits the app (default: the one `open` launched); `--release` frees the lease |
| `snapshot` | `[-i] [--all] [--depth n] [--settle [ms]]` | `--settle` ends with a `-`/`+` diff and `= N unchanged` |
| `find` | `<selector>` | matches with fresh `@eN` |
| `open` | `<bundleId\|url> [--relaunch] [--metro url] [--args ...] [--settle]` | URL on iOS accepts the "Open in ...?" sheet; running app is attached, not restarted |
| `press` / `tap` | `<@eN\|selector\|x y> [--verify] [--settle]` | |
| `fill` | `<target> <text> [--secure] [--no-verify] [--settle]` | `--` before text starting with `-`; reads back, retries once; `--secure` skips read-back and never echoes or records the text |
| `type` | `<text> [--submit] [--settle]` | into whatever has focus |
| `key` | `Enter\|Backspace\|Tab\|Space\|Escape\|Delete\|Up\|Down\|Left\|Right [--settle]` | |
| `scroll` | `<dir> [amount=0.5] [--until <sel>] [--in <target>] [--max 10] [--settle]` | content direction: `scroll down` reveals what is below; amount 0-1; `--until` prints the fresh ref |
| `alert` | `accept\|dismiss\|get [--settle]` | `get` with none = empty list; accept/dismiss with none = `no_alert` |
| `home` | `[--settle]` | |
| `back` | `[--settle]` | Android only |
| `screen rotate` | `[portrait\|portrait-upside-down\|landscape-left\|landscape-right]` | device orientation; no arg reads it |
| `screen appearance` | `[light\|dark]` | no arg reads it |
| `screen screenshot` | `[path]` | default `$WARDEN_HOME/ui/<udid>/shots/NNN.png` |
| `screen video` | `start [path]` / `stop` | 3 min device limit |
| `gesture swipe` | `up\|down\|left\|right \| x1 y1 x2 y2 [--from <target>] [--settle]` | finger direction: `gesture swipe up` reveals what is below |
| `gesture longpress` | `<target> [ms]` | default 800 ms; `--verify`, `--settle` |
| `gesture pinch` | `[target] <scale> [--duration 500] [--radius px] [--verify] [--settle]` | 2 fingers; scale > 1 zooms in, 0.1-10 and not 1; no target = screen centre |
| `gesture rotate` | `[target] <degrees> [--duration 500] [--radius px] [--verify] [--settle]` | 2 fingers; positive = clockwise, `-45` works (`gesture rotate @e3 -45`); not 0, max 720 |
| `gesture path` | `--path 'x,y x,y ...' [--path ...] [--duration ms] [--settle]` | 1-2 fingers, each >= 2 points, default 600 ms, down and lift together; points in pt (iOS) / px (Android) |

`screen ...` = the device (orientation, appearance, screenshot, video); `gesture ...` = touch. `screen rotate landscape-left` turns the device, `gesture rotate @e3 45` turns two fingers. The old top-level `rotate` `appearance` `screenshot` `video` `swipe` `longpress` are removed (unknown command). Max 2 fingers. Bad scale/degrees/`--path` = `usage` (exit 1); unsupported device = `failed`, `details.driver: E_UNSUPPORTED` (exit 1). Flows are format v2 (`kind: screen|gesture` + `type`); v1 files migrate on read.
| `wait` | `<sel>` / `absent <sel>` / `text "..."` / `stable [ms=250]` | polls 100 ms for 1 s, then 250 ms, up to `--timeout` |
| `is` | `<sel> visible\|hittable\|enabled\|checked\|selected\|focused` | exit 0 true, 1 false (JSON still `ok:true`) |
| `get` | `<sel> text\|value\|label\|id\|role\|frame\|count` | `frame` = `x y w h`; `count` 0 is success |
| `bench` | `[--runs 20] [--metro url]` | times the loop against speed targets; stops the device's helper: unshared device only |
| `eval` `tree` `logs` `network` `reload` | see Devtools | dev client only |
| `record` `replay` `export` | see Flows | |

## Selector grammar

Space-separated `key=value`, each key at most once, AND-combined.

| Key | Matches |
|---|---|
| `id=` | testID / identifier, exact |
| `label=` `text=` `value=` | case-insensitive substring |
| `role=` | normalized role (`button`, `textbox`, `checkbox`, `switch`, `text`, `heading`, ...), same on iOS and Android |
| `editable=true\|false` | text fields vs rest |
| `nth=<i>` | i-th match, 0-based |

Values: bare `id=sign-in`, quoted `label="Sign in"`, or regex `text=/^\d+ left$/i`. Several matches: actions pick the most specific visible one; pin with `nth=`. Prefer `id=`. Coordinates `x y` only for canvas content with no accessibility node.

## Verify and failure codes

`wait` runs out with exit 1 and one of: `wait_target_absent` (never in tree), `wait_target_hidden` (in tree, not visible), `wait_target_present` (`absent`: still visible), `wait_text_absent`, `wait_not_stable`. Others: `target_not_found` (selector matched nothing: `find` or `snapshot --all`), `no_alert`. `get ... count` returning 0 is success. Read the hint before retrying.

## Devtools (dev client only, else exit 3 `devtools_unavailable`)

| Command | Notes |
|---|---|
| `eval <expr> [--await]` | runs in Hermes; an exception is `failed` with details |
| `tree [--all] [--max n] [--screen name]` | React components with testID, label, rect; shows testIDs the AX tree hides |
| `logs start [--bodies]` | background collector for console + fetch |
| `logs [n]` `logs mark <label>` `logs clear` `logs stop` | default 50 lines |
| `network [n] [--include headers,body] [--id id]` | `--id` = one entry in full |
| `reload` | reload the app's JS |

`--metro <url>` on each; default order: `WARDEN_METRO_URL`, URL remembered by `open --metro`, your leased ports. Caveats:
- `logs`/`network` with no collector read the previous run's files, not the live app. `logs start` before the action.
- A collector started before a restart (`open --relaunch`, crash, rebuild) ends `lost`: `logs start` again.
- `reload` falls back to Metro's broadcast `/reload`, which reloads every device on that Metro.

## Flows

```bash
warden ui record start add-todo --udid $UDID     # .warden-ui/add-todo.flow.json
warden ui fill id=todo-input "Write docs" --udid $UDID
warden ui record stop --udid $UDID
warden ui replay .warden-ui/add-todo.flow.json --udid $UDID
warden ui export .warden-ui/add-todo.flow.json --to e2e/add-todo.e2e.ts --ids e2e/helpers/ids.ts
```

| Command | Notes |
|---|---|
| `record start <name> [--out file]` / `stop` / `status` | stores selectors, never refs; `--no-record` skips a step |
| `replay <file> [--from i] [--update-snapshots] [--settle [ms]]` | step mismatch = `replay_divergence`, exit 1; file rewritten only with `--update-snapshots` |
| `export <file> --to <spec> [--ids <module>] [--force]` | `--ids` merges into `export const ids = {...}`; coordinate taps export as `FIXME` to resolve before committing; refuses to overwrite without `--force` |

Secrets: `fill --secure` text is never stored. Set `WARDEN_UI_SECRET_<NAME>` while recording; the flow stores the name, replay and the exported spec read it from the environment.

## Exit codes and JSON envelope

| Exit | Codes |
|---|---|
| 0 | ok |
| 1 | `failed` `usage` `target_not_found` `no_alert` `wait_*` `replay_divergence` |
| 2 | `device_foreign` `device_not_leased` `no_device_leased` `ambiguous_device` `lease_not_found` |
| 3 | `engine_unavailable` `devtools_unavailable` |
| 4 | `stale_ref` |
| 130 | `interrupted` |

`--json`:
```json
{"ok":true,"command":"press","device":{"udid":"...","platform":"ios","name":"..."},"generation":5,"durationMs":412,"result":{},"warnings":[]}
{"ok":false,"command":"press","device":{},"error":{"code":"stale_ref","message":"...","hint":"...","details":{}}}
```
`generation` only when a snapshot was taken; `warnings` only when present; failures may omit `device`. Without `--json`: results on stdout, errors and warnings on stderr.

## Android differences

- Snapshots come from `warden-uiad`, a small UiAutomation server warden starts on the emulator with each command (about 0.1 s, then 10-40 ms per snapshot, taps and typing in tens of ms, non-ASCII text works). Without it (`WARDEN_ANDROID_UIAD=0`, Android < 8, a device it cannot run on) snapshots are `uiautomator dump`: 0.8-2.4 s, the first call probes three dump routes. An empty tree is retried 3 times, 400 ms apart, then `E_AX_UNAVAILABLE` (exit 3). Only one UiAutomation client can be on a device: when Maestro, an `am instrument` run or a `uiautomator` command holds it, snapshot and settle fail naming it (see troubleshooting 23).
- `id=` is the resource-id / testID without package prefix; `hittable` is derived.
- Pinch, rotate and 2-finger `gesture path` need `warden-uiad` (default on API 26+); with `WARDEN_ANDROID_UIAD=0` they fail `E_UNSUPPORTED` (`details.driver`); 1-finger paths fall back to `input motionevent`. No clipboard, no `--metro`/`--args` on `open <bundleId>`; non-ASCII text needs the server (`E_UNSUPPORTED_TEXT` without it).
- `status` showing `helper not started` is normal (no helper process).
- `back`, `home`, `screen rotate`, `screen appearance`, `screen video` work.

## View missing from the snapshot

The app must mark it `accessible` and give it a `testID`. `tree` shows it from React. The iOS helper idles out after 10 min of no calls; the next call restarts it.
