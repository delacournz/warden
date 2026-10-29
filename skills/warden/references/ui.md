# warden ui: drive a leased device by hand

For exploring, reproducing a bug, or finding selectors. Checks that must keep passing belong in a spec (`specs.md`); to create one from a session use `warden ui record` (`authoring.md`). Every call is stateless on the command line; the last snapshot and Metro URL live under `$WARDEN_HOME/ui/<udid>/`.

## Loop

```bash
warden claim ios --json                       # keep the returned udid (Android: serial)
warden dev ios --json                         # dev client only, in background; already opens the dev client
warden ui open com.example.app --udid $UDID   # launch (dev client: attaches); --metro <url> if you run Metro yourself
warden ui snapshot -i --udid $UDID            # @eN lines
warden ui press @e3 --settle --udid $UDID     # act; --settle prints what changed
warden ui wait id=todos-screen --udid $UDID   # verify with wait / is / get; a screenshot is not verification
warden ui close --release --udid $UDID
```

## Device resolution (in order)

1. `--udid` / `--serial` / `--lease <id>`
2. `WARDEN_UDID`
3. `WARDEN_UDIDS` with exactly one entry
4. your single device lease. None: exit 2 (`no_device_leased`); `--claim` claims one (label `warden ui`, 30 m). Several: your live `warden dev` device if exactly one, else `ambiguous_device`.

Every call heartbeats your lease. Another live session's lease: `device_foreign`. Stale or missing: `device_not_leased` unless `--claim`.

## Dev client

- `warden dev ios --json` already opens the dev client, without Expo's dev-menu onboarding sheet or the menu at launch (`-EXDevMenuIsOnboardingFinished YES -EXDevMenuShowsAtLaunch NO`). `open <bundleId>` then only attaches (`attached to <id>`); `--relaunch` restarts it.
- `warden ui` shares the device your own running `warden dev` holds: no `--force`, no `device_busy`. `--json` adds `"attachedTo": "<leaseId>"`; `open` prints `sharing <leaseId> with warden dev (pid N)`. `close --release` keeps that lease (warning `not released: … belongs to warden dev`); Ctrl-C `warden dev` releases it. Another session's device stays `device_foreign`; your running `warden e2e` / `batch` / `run` stays `device_busy`.
- `--metro <url>` launches the dev client on that Metro and remembers it for the devtools commands. iOS adds the same two dev-menu flags as `warden dev`, before your `--args`.
- `--relaunch` without `--metro` gives no `--initialUrl`: expo-dev-client reopens the sim's most recent Metro, often another worktree's dead port → launcher home. Relaunch with `--metro <metroUrl from warden dev>`.
- warden's Metro gets `WARDEN_WORKTREE` / `WARDEN_BRANCH`; `app.config.ts` can append them to `name` so the launcher lists each worktree's server by name.
- No Metro / fastest JS loop for a Release-like app: `warden ui open <bundleId> --kind simulator --udid $UDID` (repack, install, launch). Re-run it after a JS edit; the dev client (`warden dev`) stays the default for feature work.
- Android: `open <bundleId>` takes `--metro`/`--args` in the CLI but the driver rejects them. `warden dev android` opens the dev client via `adb reverse` + `exp+<slug>://expo-development-client/?url=...`. By hand, `open <url>` with that deep link.
- `--relaunch`, `--metro`, `--args` apply to a bundle id, not a URL (`usage`).

## Global options (every subcommand)

| Flag | Effect |
|---|---|
| `--udid <id>` `--serial <s>` `--lease <id>` | the device |
| `--claim` | claim a device when none is held, or take over a stale/missing lease |
| `--platform ios\|android` `--profile <slug>` `--runtime <rt>` | choose the device for a `--claim` with none named (default ios) |
| `--physical` | with `--claim` and no device named: claim a connected phone (`warden claim --physical`) instead of an emulator |
| `--timeout <ms>` | per-command deadline (default 5000) |
| `--force` | drive the device while your running `warden e2e` / `batch` / `run` holds it (else exit 2 `device_busy`); it disturbs that run. Not needed for your own `warden dev` |
| `--json` | one JSON document on stdout |

Actions also take `--settle [ms]`: wait for a quiet screen (budget 3000 ms), then print what changed.

Every subcommand also takes `--no-record`: while a `record` is active, this call is not appended to it. `--overwrite` (record start/stop) replaces a file; `--force` is only the busy-device option.

## Snapshot line and generations

```text
generation 4 · axbridge · 393×852@3x · 5 of 41 elements
@e1 [textbox] "Add a todo" id=todo-input value="" enabled hittable (24,118 345×48)
```

Line: `@eN [role] "name" id=<testID> value="..." <states> (x,y w×h)`. States: `enabled`/`disabled`, `hittable`, `checked`/`unchecked`, `selected`, `focused`, `secure`, `hidden`, `expanded`/`collapsed`.

- While a recording is active, `snapshot -i` appends `[no-id]` to interactive elements with no testID (`noId: true` in `--json`) and a hint. Add `testID` + `accessible` in the component, reload, `record undo`, redo by `id=`.
- `-i` = interactive elements plus anything with a testID. Cap 200 lines (`--all` removes it). `--depth n` = first n levels.
- The generation bumps on `snapshot`, `find`, any `--settle`, a matching `wait`, and `scroll --until`. Older refs then fail: exit 4 `stale_ref`, snapshot again.
- A ref older than 30 s, or any ref with `--verify`, is re-checked against a fresh snapshot (same id, else role + name, else position). Prefer `id=` selectors for anything you touch twice.

## Subcommands

| Command | Args / flags | Notes |
|---|---|---|
| `status` | | device, lease, helper, recording in progress (name, target, step count) |
| `close` | `[--app [bundleId]] [--release]` | stops this device's helper; `--app` quits the app (default: the one `open` launched); `--release` frees the lease |
| `snapshot` | `[-i\|--interactive] [--all] [--depth n] [--settle [ms]]` | `--settle` ends with a `-`/`+` diff and `= N unchanged` |
| `find` | `<selector>` | matches with fresh `@eN` |
| `open` | `<bundleId\|url> [--relaunch] [--metro url] [--args ...] [--kind dev\|simulator\|release] [--project dir] [--settle]` | URL on iOS accepts the "Open in ...?" sheet; running app is attached, not restarted. `--kind` installs that build first (`simulator` = the cached sim build with this worktree's JS repacked in, seconds; no Metro, so no `--metro`), relaunches when the build changed, and reports `kind` / `jsKey` (a repack fallback adds `fallbackReason`). Without `--kind` nothing is installed |
| `press` / `tap` | `<@eN\|selector\|x y> [--verify] [--settle]` | |
| `fill` | `<target> <text> [--secure] [--no-verify] [--via type\|paste] [--settle]` | `--` before text starting with `-`; types per key by default; `--via paste` pastes on iOS (one Cmd+V; Xcode 27 syncs every sim's pasteboard with the Mac clipboard both ways, so a paste lands in clipboard history and on other sims; the retry always types); reads back, retries once; `--secure` skips read-back and never echoes the text |
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
| `wait` | `<sel>` / `absent <sel>` / `text "..."` / `stable [ms=250]` | polls 100 ms for 1 s, then 250 ms, up to `--timeout` (default 5000); `stable` keeps 100 ms |
| `is` | `<sel> visible\|hittable\|enabled\|checked\|selected\|focused` | exit 0 true, 1 false (JSON still `ok:true`) |
| `get` | `<sel> text\|value\|label\|id\|role\|frame\|count` | `frame` = `x y w h`; `count` 0 is success |
| `record start` | `<name> [--to <spec> \| --helper <module#fn> [--prerequisite <text>]] [--ids <module>] [--options <module#name>] [--title <t>] [--suite <n>] [--overwrite]` | from now on every action is journaled; default file `<suite specsDir>/<name>.e2e.ts` (`e2e/<name>.e2e.ts` without a suite); `--options` = shared `test.use` options (default detected, `none` passes none); see `authoring.md` |
| `record note` | `"<text>"` | user-visible step; comment above the next action |
| `record use` | `<module#fn> [--suite <n>]` | run an exported helper on this device; on a pass record `await fn(fixtures)`, on failure record nothing (`use_failed`); see `authoring.md` |
| `record undo` | `[n=1]` | drop the last n steps (notes count) |
| `record status` | | target, step count, last 5 steps, lints so far |
| `record cancel` | | drop the journal; a spec already written stays |
| `record stop` | `[--no-verify] [--suite <n>] [--overwrite]` | write spec/helper, merge ids, print lints, run the spec once on this device (helpers are not run); exit 1 keeps file and journal |
| `bench` | `[--runs 20] [--metro url]` | times the loop against speed targets (default 20 runs; cold start, settle and open capped at 3-5); `--metro` for the tree metric; stops the device's helper: unshared device only |
| `eval` `tree` `logs` `network` `reload` | see Devtools | dev client only |

`screen ...` = the device (orientation, appearance, screenshot, video); `gesture ...` = touch. `screen rotate landscape-left` turns the device, `gesture rotate @e3 45` turns two fingers. The old top-level `rotate` `appearance` `screenshot` `video` `swipe` `longpress` are removed (unknown command). Max 2 fingers. Bad scale/degrees/`--path` = `usage` (exit 1); unsupported device = `failed`, `details.driver: E_UNSUPPORTED` (exit 1).

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

`warden dev` starts with **no** devtools broker (and no perf HUD): only build, Metro, sim and app. Each devtools verb then connects directly. Turn the broker on when you debug: `warden dev enable devtools` (or `warden dev ios --devtools --json` at start). While it is on, every devtools verb goes through it: one CDP socket the session holds, capturing console, exceptions and fetches from the moment it attached (no `logs start`, nothing missed after that). `warden dev disable devtools` frees the socket.

| Command | Notes |
|---|---|
| `warden dev enable <hud\|perf\|devtools\|all…> [--udid u] [--json]` | turns extras on in the running session; `perf` = `hud`; prints `<udid>: hud on · devtools on`, `--json` `{ udid, features }` |
| `warden dev disable <…>` · `warden dev status` | off again · read the state. `hud` needs the dashboard (a `--json` run: exit 1 "no dashboard", use `warden perf start`) |

A session started by an older warden has no control socket: restart `warden dev`.

| Command | Notes |
|---|---|
| `eval <expr> [--await]` | runs in Hermes; an exception is `failed` with details |
| `tree [--all] [--max n] [--screen name]` | React components with testID, label, rect; shows testIDs the AX tree hides |
| `route` | route key of the screen on show (`(tabs)/todos`) |
| `logs [n] [--since 5m] [--level warn] [--grep x] [--limit n]` | console lines, stacks symbolicated to source; default 50 |
| `exceptions [--since] [--limit]` | uncaught errors, incl. the ones React Native reports as `console.error` |
| `network [n] [--since] [--grep url] [--status 404\|4xx] [--limit n] [--include headers,body] [--id id]` | default 50; `--id` = one entry in full; `--include` adds headers/bodies |
| `reload` | reload the app's JS |
| `logpoint add <file:line[:col]> '<expr>' [--id x] [--hits n]` | logs `<expr>` each time the line runs, never pauses; needs `warden dev` with devtools on, Fusebox |
| `logpoint hits [id] [--since]` · `logpoint list` · `logpoint rm <id>` · `logpoint clear` | values logged; logpoints die with the session, re-arm across reloads |
| `devtools status` · `devtools resume` | broker state (`attached`, `yielded`, `lost`); `resume` after it yielded to Chrome DevTools |
| `logs start [--bodies]` · `logs mark <label>` · `logs clear` · `logs stop` | collector, only without a broker (a no-op `via: broker` with devtools on) |

Bundler output is not in CDP: `warden dev logs [--kind bundle_failed,error] [--since 5m] [--grep x] [--follow] [--json]` reads Metro's output, classified (`bundle_start|bundle_done|bundle_failed|hmr|error|warn|info`, errors with file/line/code frame). Recorded only by the dashboard (a terminal); `--json`/`--no-tui` runs return `metro_log_unavailable`.

Debug loop: `warden dev logs --kind bundle_failed,error` (does it build?) → `ui exceptions` / `ui logs --level warn` → `ui logpoint add src/x.tsx:42 '{ a, b }'` + reproduce + `ui logpoint hits` → `ui eval` to read state. Same tools over MCP: `warden mcp` (`metro_logs`, `app_console`, `app_exceptions`, `app_eval`, `logpoint_*`, `profile_*`, …).

`--metro <url>` on each direct call; default order: `WARDEN_METRO_URL`, URL remembered by `open --metro`, your leased ports. Caveats:
- Chrome DevTools (`j` in Expo) on a single-debugger Metro (headless/CI Expo) takes the page: the broker yields (`devtools status` → `yielded`) and calls fail `devtools_unavailable` until `devtools resume`, which disconnects DevTools. Interactive `warden dev` allows both at once.
- Without a broker, `logs`/`network` with no collector read the previous run's files, not the live app. `logs start` before the action. A collector ends `lost` after a 30 s reconnect budget (relaunch, crash, rebuild) and stops after 60 s idle.
- `reload` falls back to Metro's broadcast `/reload`, which reloads every device on that Metro.
- A reload drops a running `warden perf js` / profile recording (Hermes ties it to the socket).

## Exit codes and JSON envelope

| Exit | Codes |
|---|---|
| 0 | ok |
| 1 | `failed` `usage` `target_not_found` `no_alert` `wait_*` `no_recording` `recording_active` `target_exists` `empty_recording` `verify_failed` `verify_unavailable` `helper_missing` `use_failed` |
| 2 | `device_foreign` `device_busy` `device_not_leased` `no_device_leased` `ambiguous_device` `lease_not_found` `device_unknown` `device_unauthorized` `device_offline` |
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

- Snapshots come from `warden-uiad`, a small UiAutomation server the emulator's resident host (`warden __android-host`) keeps running between calls (about 0.1 s to start, then 10-40 ms per snapshot, taps and typing in tens of ms, non-ASCII text works). Without it (`WARDEN_ANDROID_UIAD=0`, Android < 8, a device it cannot run on) snapshots are `uiautomator dump`: 0.8-2.4 s, the first call probes three dump routes. An empty tree is retried 3 times, 400 ms apart, then `E_AX_UNAVAILABLE` (exit 3). Only one UiAutomation client can be on a device: when Maestro, an `am instrument` run or a `uiautomator` command holds it, snapshot and settle fail naming it (see troubleshooting 23).
- `id=` is the resource-id / testID without package prefix; `hittable` is derived.
- Pinch, rotate and 2-finger `gesture path` need `warden-uiad` (default on API 26+); with `WARDEN_ANDROID_UIAD=0` they fail `E_UNSUPPORTED` (`details.driver`); 1-finger paths fall back to `input motionevent`. No clipboard, no `--metro`/`--args` on `open <bundleId>`; non-ASCII text needs the server (`E_UNSUPPORTED_TEXT` without it).
- The first call starts the host; it exits after 10 idle minutes (`WARDEN_ANDROID_HOST_IDLE_TIMEOUT`), on `warden ui close`, or on release. `status` shows it as the helper. `WARDEN_ANDROID_HOST=0` drives in-process (each call reopens adb + uiad).
- `back`, `home`, `screen rotate`, `screen appearance`, `screen video` work.
- Physical phone (`--serial <adb serial>` of a phone, `ip:port` / `adb-…` for wireless debugging, or `--claim --physical`): the lease is stamped `physical`. adb state `unauthorized` exits 2 `device_unauthorized`, any other non-`device` state exits 2 `device_offline` (the lease is kept; fix the phone and retry). A sleeping phone is woken and a keyguard with no credential is dismissed; a PIN / pattern / password keyguard fails `E_DEVICE_LOCKED` (exit 3), warden never unlocks. A device whose `ro.boot.qemu` / `ro.kernel.qemu` is 1 (`localhost:5555`, Genymotion) is a foreign emulator, not a phone. Rotation, `screen appearance` and the animation scales are saved before the first change and put back on close (a crashed run's originals are restored by the next driver). `uninstall` / `clearData` only act on `WARDEN_BUNDLE_ID` and packages warden installed there (`E_REFUSED`, `physical_protected`). Install checks the APK's ABIs first (`abi_mismatch`: use the `dev` or `release` kind) and never uninstalls a differently-signed copy.
- A physical iPhone is driven through a resident `warden __ios-runner-host` (one per phone, log: `$WARDEN_HOME/ios-runner/<udid>.log`): it keeps the signed XCUITest runner alive on the phone and reaches it over the CoreDevice tunnel. It exits after 10 idle minutes (`WARDEN_IOS_RUNNER_IDLE_TIMEOUT`), on `warden ui close`, or on release. A runner that cannot start logs one code: `E_DEVICE_LOCKED` (unlock the phone), `E_TUNNEL_DOWN`, `E_INSTALL_FAILED`, `E_DEVELOPER_MODE_OFF`, `E_RUNNER_UNTRUSTED`, `E_DEVICE_BUSY`, `E_READY_TIMEOUT`.

## View missing from the snapshot

The app must mark it `accessible` and give it a `testID`. `tree` shows it from React. The iOS helper idles out after 10 min of no calls; the next call restarts it.
