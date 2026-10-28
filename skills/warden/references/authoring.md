# Authoring specs: record a `warden ui` session into `*.e2e.ts`

Use when asked to "create / write / record an e2e test for X". You drive the app with `warden ui`; `warden ui record` turns the session into a `@delacour/warden-e2e` spec and runs it once on the same device. No intermediate file: the spec runner is the replay. Spec API: `specs.md`; driving: `ui.md`; running suites: `suites.md`.

## Procedure ("an e2e test for onboarding and sign in")

1. Split the request into journeys, one spec each (`onboarding`, `sign-in`). A step sequence a later spec repeats (onboarding before sign-in) is recorded once as a helper and called with `record use`, see "Several journeys".
2. Claim, then start the app: `warden claim ios --json` → `UDID`; for a dev client `warden dev ios --json` (background). Pass `--udid $UDID` on every call.
3. `warden ui record start <id> --udid $UDID` (add `--ids e2e/helpers/ids.ts` to merge testIDs into the app's ids module; `--title "<test title>"`; `--suite <name>`: required when the config has several suites, also with `--to`; `record use` and the verify run on it).
4. First recorded step is the launch: `warden ui open <bundleId> --relaunch --udid $UDID` (`--metro <metroUrl>` for a dev client). It becomes `app.open({ wait: "quiet" })` (first screen mounted and still before the next tap; a tap right after a bare launch can be dropped), so the spec starts from a fresh app. An `open` made before `record start` is not in the spec. When the first step is an `open` (or a `record use` of a helper that opens the app) the spec gets `test.use({ launch: "none" })` so the runner does not launch the app a second time, see "Shared options and launch".
5. Per screen:
   - `warden ui snapshot -i --udid $UDID`; act on `id=` selectors (`press id=get-started`, `fill id=email "me@example.com"`). `@eN` refs work but are stored as selectors.
   - After every action that changes the screen: `warden ui wait id=<landmark testID of the new screen>`. It becomes `expect(...).toBeVisible()`; without it `record stop` warns `unverified_navigation`.
   - Assert what the user should see with `wait` / `is` / `get <sel> text` (they become `expect(...)`), not with screenshots.
   - A dev client launched by `warden dev` can show Expo's developer-menu sheet over the app: dismiss it with `--no-record` calls (`press id=… --no-record`), never record it. `open --args` cannot take values that start with `-`.
   - `warden ui record note "<user-visible step>"` before each group of actions (comment above the next step, e.g. `enter credentials`).
6. Snapshot shows `[no-id]` on an interactive element (JSON: `noId: true`): stop driving. Add `testID` + `accessible` to the component, reload (`warden ui reload` or `open --relaunch`), `warden ui record undo` back to before the step, redo it by `id=`. Never keep a text selector or coordinates when you can add a testID.
7. Misstep (wrong tap, typo): `warden ui record undo [n]` (notes count as steps), redo. Exploring without recording a step: add `--no-record` to that call (read-only queries you don't want as `expect`).
8. `warden ui record stop --udid $UDID` (`--no-verify` writes without the run; always so for `--helper`): writes `<specsDir>/<id>.e2e.ts` (default `e2e/<id>.e2e.ts` with no suite), merges ids, prints lints, then runs the spec once on this device.
9. Verify failed (exit 1, `verify_failed`): file and journal are kept. Read `screen-at-failure.txt` (path printed, under `$WARDEN_HOME/ui/<udid>/verify/<ts>/`). Fix the app (testID, missing wait) or `record undo` + redo, then `record stop` again (`--overwrite` is not needed: the file is yours). `record cancel` drops the journal; the written file stays.
10. Fix every lint and FIXME in the file (below). Then run it the real way: `warden e2e <suite> --specs <id>`.
11. `stop` prints the `specs.<id>` entry to paste into `warden.config.ts`; warden never edits the config. Paste it so `warden affected` selects the spec. See "Route capture" for what fills `entries`.
12. `warden ui close --release --udid $UDID`.

## Several journeys

One spec per journey. A shared prefix is a helper:

```bash
warden ui record start onboarding --helper e2e/helpers/flows.ts#onboarding --prerequisite "fresh install, app closed" --ids e2e/helpers/ids.ts --udid $UDID
warden ui open <bundleId> --relaunch --udid $UDID       # ...drive onboarding to the first signed-out screen...
warden ui record stop --udid $UDID                      # writes `export async function onboarding(...)`; helpers are not verified
```

The journey that owns the helper still needs its own spec ("test onboarding"): start `onboarding`, `record use` the helper, `wait` on the landmark it leaves you on, `record stop` (a two-step spec; the assertions live in the helper). Next spec: start it, then `record use` the helper where it belongs (before any `open`; the helper brings the app to its end state). `use` runs the helper once on this device, and only if it passes records `await onboarding(fixtures)`; a failing helper records nothing (exit 1 `use_failed`, evidence paths in `details.evidence`).

```bash
warden ui record start sign-in --ids e2e/helpers/ids.ts --udid $UDID
warden ui record use e2e/helpers/flows#onboarding --udid $UDID      # <module>#<fn>, module relative to the cwd
warden ui wait id=sign-in-screen --udid $UDID                       # landmark of the screen the helper leaves you on
# ...drive sign-in...
warden ui record stop --udid $UDID                                  # verify runs the whole spec, helper included
```

The spec gets `import { onboarding } from "./helpers/flows";` (relative to the spec's final path, no extension, merged with its other imports from that module) and, because the test hands the whole fixtures object to the helper, `async (fixtures) => { const { screen } = fixtures; await onboarding(fixtures); … }`. Helpers must take `TestFixtures` (the ones `--helper` writes do). After `use`, the next snapshot is fresh (old `@eN` refs are stale) and the route is re-read; `use` counts as a navigation, so follow it with a `wait` or `record stop` warns `unverified_navigation`. Nothing to edit by hand. The helper's prerequisite doc comment says what must hold when it is called. `record start --helper` refuses an existing export (`target_exists`); `--overwrite` on `record start` (remembered by `stop`) replaces it. `record use` also collects the routes the helper visits and `stop` merges them into the consuming spec's `entries`, see "Helper routes".

## Secrets

`fill --secure` never stores the text. Export `WARDEN_UI_SECRET_<NAME>=<value>` in the shell that runs `record` / `fill --secure`: the step becomes `process.env.WARDEN_UI_SECRET_<NAME>` with a guard that throws when unset, and any typed text equal to the value is redacted the same way. Without the variable the step uses `SECURE_TEXT` and a note: set `WARDEN_UI_SECRET_SECURE_TEXT` or edit the step. Provide the variable to `warden e2e` too (suite `env`).

## Lints printed by `record stop` (and `record status`)

| Code | Level | Fix |
|---|---|---|
| `coords_target` | error | tap by coordinates, or `type`/`key` with no element: add `testID` + `accessible`, undo, redo by id |
| `text_only_selector` | warn | selector has no `id=`: add a testID, undo, redo |
| `ambiguous_selector` | warn | selector matched several elements and is pinned by `nth=`: give it a unique testID |
| `unverified_navigation` | warn | a navigation was followed by an action with no `wait`/`is`: add a `wait id=<landmark>` (undo to there, redo) |
| `empty_recording` | error (`stop` fails) | nothing but notes: drive the app after `record start` |

A coordinate target also leaves a `// FIXME` in the spec (it throws until fixed). Resolve all FIXMEs.

## What is recorded

Every `warden ui` action and query while recording unless `--no-record`: `open`, `press`/`tap`, `fill`, `type`, `key`, `scroll`, `alert`, `home`, `back`, `gesture *`, `screen rotate|appearance|screenshot`; `wait <sel>` / `is` / `get` become `expect(...)` (`is` states: visible hidden enabled disabled checked unchecked; `get` only `text` / `value`). Not recorded: `wait absent|text|stable`, `snapshot`, `reload`, `find`, `eval`, `tree`, `logs`, `network`, `status`. Selectors are stored, never `@eN`. `record status` shows target, step count, last 5 steps and lints so far; `ui status` shows `recording`.

## Good spec checklist

- Every element is found by `id=` (testID + `accessible` in the component); no coordinates, no text selectors.
- A landmark `wait id=` after every navigation; the first step is `open --relaunch`.
- Asserts the outcome (`wait`/`is`/`get`), not just that taps happened.
- No sleeps; no `device.settle()` unless you need it (`--settle` records one: don't pass `--settle` while recording, `wait` on a landmark instead).
- Secrets via `WARDEN_UI_SECRET_<NAME>`, never literals; `record note` per user-visible step; no FIXME left.
- Passes via `warden e2e <suite> --specs <id>`, not only the verify run.

## Worked example

```bash
warden claim ios --json                                   # → UDID
warden dev ios --json                                     # background; first line has metroUrl
warden ui record start sign-in --ids e2e/helpers/ids.ts --udid $UDID
warden ui open nz.co.delacour.warden.example --relaunch --metro http://localhost:8091 --udid $UDID
warden ui wait id=welcome-screen --udid $UDID
warden ui record note "open sign in" --udid $UDID
warden ui snapshot -i --udid $UDID                        # sign-in-open [no-id]? add testID, reload, undo, redo
warden ui press id=sign-in-open --udid $UDID
warden ui wait id=sign-in-form --udid $UDID
warden ui record note "enter credentials" --udid $UDID
warden ui fill id=email "ada@example.com" --udid $UDID
WARDEN_UI_SECRET_PASSWORD=... warden ui fill id=password "..." --secure --udid $UDID
warden ui press id=sign-in-submit --udid $UDID
warden ui wait id=todos-screen --udid $UDID
warden ui record stop --udid $UDID                        # writes e2e/sign-in.e2e.ts, runs it once
warden e2e example --specs sign-in
warden ui close --release --udid $UDID
```

Generated:

```ts
test.use({ launch: "none" });

test("sign-in", async ({ app, screen }) => {
	const passwordSecret = process.env.WARDEN_UI_SECRET_PASSWORD;
	if (passwordSecret === undefined) throw new Error("set WARDEN_UI_SECRET_PASSWORD to run this spec");
	await app.open({ wait: "quiet" });
	await expect(screen.getByTestId(ids.welcomeScreen)).toBeVisible();
	// open sign in
	await screen.getByTestId(ids.signInOpen).tap();
	await expect(screen.getByTestId(ids.signInForm)).toBeVisible();
	// enter credentials
	await screen.getByTestId(ids.email).fill("ada@example.com");
	await screen.getByTestId(ids.password).fill(passwordSecret);
	await screen.getByTestId(ids.signInSubmit).tap();
	await expect(screen.getByTestId(ids.todosScreen)).toBeVisible();
});
```

## Route capture (`specs.<id>` entries)

While recording, warden reads the app's Expo Router route after each navigating action (`press`, `open`, `back`, `key`, `alert`, `use`) and keeps it on the step when it changed. `stop` maps the routes visited to files under the suite's `routerRoot` and prints the snippet.

- Dev clients only: the route comes from the React DevTools hook through Metro (`ui open --metro` / `warden dev`). A Release build has no hook: `entries: []` plus a TODO hint to fill them by hand.
- Set the suite's `routerRoot` (e.g. `src/app`) in `warden.config.ts`, or routes cannot be mapped to files and `entries` stays empty.
- Capture gives up after 3 failed reads in a row (a Release build, no Metro); a later successful read does not restart it once given up.
- `record stop --json`: `result.config` = `{ id, suite?, snippet, entries, routes, unresolved, captured, hints }`; `null` for a helper. `unresolved` = visited routes with no file under `routerRoot`; `captured: false` = nothing was read.
- warden never edits `warden.config.ts`: paste `snippet` yourself.

## Helper routes

The spec process cannot report which screens a helper drives, so `record use` combines what warden can see:

1. The helper's own recording: `record stop` on a `--helper` target saves the routes that recording visited under `$WARDEN_HOME/ui/helper-routes` (never in the repo). `record use` of that helper reads them back.
2. The route read before and after the run (`visited` on the `use` step is these plus 1, in order, each once).

`stop` merges every `use` step's `visited` into the spec's routes (before the route the step ended on), so they map to `entries` like any other route. The "helper ... drives screens this recording never saw" hint is dropped when each helper has a recording of its own and kept (naming the helpers) when one has not. Limits: a hand-written helper, or one edited after it was recorded (the saved routes are tied to the function's source hash), only gives the before/after reads (`record use` prints `routes: ... (only the reads before and after the run ...)`, JSON `routes: "reads"`, the step gets `partial: true`); screens in the middle are then yours to add by hand. A Release build reads nothing, so only the helper's saved routes (if any) count. A helper called by another helper contributes through that helper's own recording, which includes the inner helper's routes.

## Shared options and launch

Hand-written suites often share one `test.use` object (e.g. `SPEC_OPTIONS = { launch: "none", systemAlerts: "dismiss" }` in `e2e/helpers/steps.ts`). `record stop` detects it with an explicit rule (spec files only; helper recordings never get one):

1. Candidates: `export const NAME = { … }` in a `.ts`/`.tsx` file below the suite's `specsDir` that is not a spec (`*.e2e.ts`) or test (`*.test.ts`), whose keys are only `test.use` options (`timeout`, `actionTimeout`, `assertionTimeout`, `launch`, `systemAlerts`).
2. Kept: candidates that at least one existing spec imports (relative import) and passes to `test.use(NAME)` or `test.use({ ...NAME, … })`.
3. Exactly one kept: the generated spec imports it and calls `test.use(NAME)`. More than one: none is passed and `stop` prints `several shared spec options fit (A, B)`. None: unchanged output.

Override on `record start`: `--options e2e/helpers/steps#SPEC_OPTIONS` pins one (it must exist), `--options none` passes none. The result JSON has `options: { module, name } | null` and `launch`.

Launch: the runner launches the app fresh before each test unless `launch` is `"none"`. A recording whose first step is `open` of the app, or a `record use` of a helper whose body calls `app.open(` (directly or through a function of the same module, up to 4 calls deep; imports from other modules are not followed), launches it itself, so the spec needs `launch: "none"` or the app starts twice. Codegen writes the file-scope `test.use` that makes the spec's launch right: `test.use({ launch: "none" })` alone, `test.use(SPEC_OPTIONS)` when the shared object already says so, or `test.use({ ...SPEC_OPTIONS, launch: "fresh" })` when the shared object turns the launch off but the recording relies on the runner's (first step is an action, not an `open`). The runner has no per-test launch option; `test.use` is the only place.

## Why there are no tap retries

Do not wrap a recorded `tap` in a retry (`tap({ until })`, a loop, `retry` on the test). A tap that "did not land" may have landed and be slow: re-sending it double-fires anything not idempotent (add a todo twice, toggle back, submit twice). Wait for the thing the tap causes instead: `open` records `wait: "quiet"` (app in front and still, so the first tap is not dropped), and a landmark `wait id=` after every navigation becomes `expect(...).toBeVisible()`, which fails at the step that went wrong. If a screen needs time to become tappable, wait for a testID that only appears when it is ready.

## Errors (`record ...`, exit 1)

| Code | Meaning |
|---|---|
| `recording_active` | one recording per device; `record stop` or `record cancel` first |
| `no_recording` | `note`/`undo`/`cancel`/`stop` with none started |
| `target_exists` | spec file or helper export exists: `--overwrite`, or `--to` / another name |
| `empty_recording` | no steps to write |
| `helper_missing` | `record use`: the module file does not exist or does not export the function |
| `use_failed` | `record use`: the helper failed on the device; evidence in `details.evidence`; nothing recorded |
| `verify_failed` | the spec failed on the device: evidence paths in `details.evidence`; file and journal kept |
| `verify_unavailable` | verify could not run (no/ambiguous suite, runner error): fix, or `--suite <name>`, or `--no-verify`; journal kept |

`--force` is the shared `ui` option for a device held by your own `warden e2e`/`batch`/`run`; replacing a file is `--overwrite`.
