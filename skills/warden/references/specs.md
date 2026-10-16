# Specs: `*.e2e.ts` with `@delacour/warden-e2e`

Read this to write or fix a spec. A spec is a `bun test` file. `warden e2e` runs it on leased devices (see `suites.md`). To explore the UI first, use `warden ui` (see `ui.md`).

## Install and preload

```bash
bun add -d @delacour/warden-e2e@<warden version>   # version must equal `warden --version`
```

- A version mismatch makes the preload exit 2 and print the `bun add -d @delacour/warden-e2e@<v>` fix.
- The preload registers the session and raises bun's timeout. It does nothing without `WARDEN_UDID`.
- Enable it for every `bun test` in `bunfig.toml`:

```toml
[test]
preload = ["@delacour/warden-e2e/preload"]
```

- Or pass `--preload @delacour/warden-e2e/preload` on each run (see "By hand").

## Layout

```
e2e/<flow>.e2e.ts        flow id = path under flowsDir minus .e2e.ts (e2e/auth/sign-in.e2e.ts -> auth/sign-in)
e2e/helpers/ids.ts       export const ids = { ... } as const   (mirrors the app's testIDs)
e2e/helpers/flows.ts     shared steps (launch, signedIn, tapUntil)
e2e/helpers/poll.ts      pollUntil
```

## Imports

```ts
import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll, E2eError } from "@delacour/warden-e2e";
import type { App, Device, Screen, Locator, TestFixtures } from "@delacour/warden-e2e";
```

Never import subpaths (`/device`, `/screen/*`, `/env`). Only `.` and `./preload` are published. (The repo's example helpers use subpaths because the workspace exposes `./*`; copy the root type imports instead.)

## Test API

- `test(title, [options], async ({ app, device, screen, platform }) => ...)`
- `options`: `{ timeout, skip, only, platforms: ("ios"|"android")[], retry }`. `retry` is bun's retry; only the last attempt lands in `results.jsonl`.
- `test.skip`, `test.only`, `test.todo(title)`, `test.skipIf(cond)(title, body)`.
- `test.use({ timeout?, actionTimeout?, assertionTimeout?, launch?: "fresh" | "none" })` applies to the file or the enclosing `describe`.
- `test.extend<Extra>({ name: async (base, use) => { await use(value) } })` returns a `test` with the extra fixture.
- `describe(title, [{ serial }], body)`. `serial` is accepted but changes nothing (bun runs a file's tests in order).
- `beforeEach/afterEach` receive the fixtures. `beforeAll/afterAll` receive `app`, `device`, `screen`, `platform` only.
- The runner calls `app.open()` before every test unless `launch: "none"`. A flow starts from a fresh launch.
- Timeouts: test 120 s, action 30 s, assertion 5 s. Precedence: test option, then `test.use`, then env (`WARDEN_E2E_*`). In a suite, set them under `spec`.

## Fixtures

### `app` (the app under test, `WARDEN_BUNDLE_ID`)

| Member | Does |
|---|---|
| `open({ url?, args?, env? })` | terminate, relaunch with `WARDEN_LAUNCH_ARGS` + `args`, then open `url` |
| `close()` | terminate |
| `restart()` | relaunch with `WARDEN_LAUNCH_ARGS` |
| `reinstall()` | uninstall + install from `WARDEN_APP_PATH` (throws without it) |
| `clearData()` | wipe app data and keychain, keep the build |
| `isRunning()` | boolean |

### `device`

| Member | Does |
|---|---|
| `alert("accept" \| "dismiss" \| { button })` | answer the system alert on top; `false` when none; `ACTION_FAILED` for a missing named button |
| `openLink(url, { accept? })` | open a URL from outside the app; presses "Open" on the iOS sheet (up to 3 times, 8 s) |
| `home()` / `back()` | home key / Android back (iOS throws) |
| `orientation(set?)` | `"portrait" \| "portraitUpsideDown" \| "landscapeLeft" \| "landscapeRight"`; returns current |
| `appearance(set?)` | `"light" \| "dark"`; returns current |
| `clipboard()` / `setClipboard(text)` | read / write |
| `hideKeyboard()` | iOS presses Enter (may submit the field); Android presses back |
| `screenshot(name)` | saves `<attemptDir>/screenshots/NNN-<slug>.png`, returns the path |
| `snapshot({ interactiveOnly? })` | AX tree as text (same format as `warden ui snapshot`) |
| `settle({ quietMs = 250, timeout = 3000 })` | wait for a quiet UI; returns `{ quiet, waitedMs }`; hitting the deadline is not an error |
| `devtools` | `undefined` without `WARDEN_METRO_URL` (release build) |

### `device.devtools` (dev client over Metro)

| Member | Does |
|---|---|
| `evaluate(expr)` | run JS in the app; returns a result object |
| `reloadJs()` | reload the JS bundle |
| `tree()` | React component tree with rects |
| `network.entries()` | captured requests |
| `console.lines()` / `clear()` / `mark(label)` | captured console |
| `connect()` | the attached facet; throws `SESSION` when unreachable |

### `screen` (queries are lazy until an action or assertion)

| Member | Does |
|---|---|
| `getByTestId(id, { visible? })` | by `testID` |
| `getByText(t, { exact?, visible? })` | by text |
| `getByLabel(t, opts)` / `getByPlaceholder(t, opts)` / `getByValue(t, opts)` | same options as `getByText` |
| `getByRole(role, nameOrOpts?, opts?)` | opts: `name exact checked disabled selected visible` |
| `locator("id=... label=... role=... nth=1")` | the `warden ui` selector grammar |
| `tapAt({ x, y })` | tap a point |
| `swipe({ direction, momentum? })` or `swipe({ from, to, durationMs? })` | `direction` up/down/left/right, `momentum` `"none" \| "slow" \| "fast"` |
| `scrollUntilVisible(locator, { direction = "down", momentum?, maxSwipes = 10, timeout? })` | scroll the screen |

Roles: button link textbox searchbox checkbox radio switch slider image heading text tab tablist menu menuitem list listitem row alert dialog navigation group other.

`TextMatch = string | RegExp`. A string matches the whole text, case-sensitive, whitespace collapsed. `exact: false` makes it a case-insensitive substring.

### `Locator`

- **Scope:** `getBy*`, `locator()`, `filter({ hasText?, has? })`, `first()`, `last()`, `nth(i)`.
- **Reads (no waiting):** `count() all() text() allTexts() value() isVisible() isHidden() isEnabled() isChecked() boundingBox()`.
- **Wait:** `waitFor({ state: "attached" | "detached" | "visible" | "hidden", timeout? })`. Default state is `visible`.
- **Actions** wait for exactly one visible match. Several matches fail with `LOCATOR_AMBIGUOUS`.
  - `tap({ position?, timeout? })`, `longPress({ durationMs? })`
  - `fill(text)` backspaces, types, verifies on two reads, retries once. Secure fields are not verified.
  - `clear()`, `type(text)` (at the caret)
  - `press(key, { modifiers? })` sends a KEY (`Enter Backspace Tab Space Escape Delete Up Down Left Right`), it is not a tap. Use `tap()` to tap.
  - `swipe({ direction, momentum? })`, `scrollTo()`

## Matchers

`expect(locator)` polls every 100 ms. Any other value goes to bun's `expect`.

`toBeVisible toBeHidden toHaveText(t, { exact? }) toContainText(t, { ignoreCase? }) toHaveValue(v) toBeChecked({ checked? }) toBeEnabled toBeDisabled toHaveCount(n)`. All take `{ timeout? }`.

- Zero matches keep polling. Several matches fail at once (except `toHaveCount`).
- `.not` passes only after the inverted state held for 1000 ms.
- `expect.soft(locator)` records the failure and the test fails when its body ends.
- Failures are `E2eError` with a `code`: `LOCATOR_NOT_FOUND LOCATOR_AMBIGUOUS INVALID_LOCATOR ACTION_FAILED TIMEOUT NOT_ACTIONABLE INVALID_ARGUMENT SESSION DRIVER ASSERTION`.

## Example spec (`apps/example/e2e/todos.e2e.ts`)

```ts
import { expect, test } from "@delacour/warden-e2e";
import { signedIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("add, complete and filter todos", async ({ device, screen }) => {
	await signedIn(device, screen);
	const remaining = screen.getByTestId(ids.todos.remaining);

	await screen.getByTestId(ids.todos.input).fill("Write e2e flows");
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Write e2e flows");
	await expect(remaining).toHaveText("2 left");

	await screen.getByTestId(ids.todos.check("todo-1")).tap();
	await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked();
	await expect(remaining).toHaveText("1 left");

	await screen.getByTestId(ids.todos.filter("active")).tap();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeHidden();

	await screen.getByTestId(ids.todos.check("welcome")).tap();
	await expect(screen.getByTestId(ids.todos.empty)).toBeVisible();

	await screen.getByTestId(ids.todos.filter("done")).tap();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeVisible();
	await expect(remaining).toHaveText("0 left");
});
```

## Helper patterns (`apps/example/e2e/helpers/flows.ts`)

The first press after a launch or navigation can be dropped, and a HID tap has no ack. So flows wait for the result and re-tap.

```ts
export async function launch(device: Device, screen: Screen): Promise<void> {
	await device.alert("dismiss");
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
	await device.settle({ quietMs: 250, timeout: 3_000 });
}

export async function tapUntil(
	target: Locator,
	arrived: () => Promise<boolean>,
	options: { windowMs?: number; pollMs?: number } = {}   // defaults 4000 / 250
): Promise<void> {
	await target.tap();
	for (let attempt = 0; attempt < 2; attempt += 1) {      // up to 2 more taps
		const deadline = Date.now() + (options.windowMs ?? 4_000);
		while (Date.now() < deadline) {
			if (await arrived()) return;
			await new Promise((r) => setTimeout(r, options.pollMs ?? 250));
		}
		await target.tap();
	}
}
```

- `nextStep(screen, title)`: `tapUntil` on the Next button until the step title shows, then `toHaveText`.
- `expectTodosAfterSignIn`: loop `device.alert("dismiss")` + `isVisible()` for up to 15 s, then one final `toBeVisible({ timeout: 1 })` for the error.
- `openDeepLink`: up to 3 `device.openLink(url)`, each waiting 6 s for the target screen.
- `pollUntil(read, accept, 10_000)` in `helpers/poll.ts` polls a read until `accept` likes it.
- Helpers take `Device` / `Screen` / `Locator` as parameters; import them as types from the package root.

## Accessibility rule

Specs read the accessibility tree, not React. A `testID` shows up only when the view is `accessible`. Keep switches and checkboxes real controls so `toBeChecked` works. Fix the component, not the flow. Inspect with `warden ui snapshot -i --udid <udid>`, `warden ui tree` (dev client), or `screen-at-failure.txt`.

## By hand

```bash
warden claim ios --json          # -> udid; install: warden app ensure ios --udid <udid>
WARDEN_UDID=<udid> WARDEN_BUNDLE_ID=<bundleId> \
  bun test --preload @delacour/warden-e2e/preload e2e/todos.e2e.ts
```

- The preload is mandatory unless `bunfig.toml` already has it.
- Optional env: `WARDEN_PLATFORM=android`, `WARDEN_METRO_URL` and `WARDEN_LAUNCH_ARGS` (JSON array) for a dev client (take both from `warden dev ios --json`), `WARDEN_E2E_OUT`, `WARDEN_E2E_TIMEOUT`, `WARDEN_E2E_ACTION_TIMEOUT`, `WARDEN_E2E_ASSERTION_TIMEOUT` (ms), `WARDEN_E2E_DEBUG=1` (log every helper op with its duration), `WARDEN_APP_PATH`, `WARDEN_SIMD_SOCKET`.
- Release the lease when done: `warden release <leaseId>`.

## Artifacts

`<out>/<flowId>/<title-slug>-<hash6>/`. `<out>` is `WARDEN_E2E_OUT`, default `.warden-e2e/<ISO time>`. Under `warden e2e` it is `<batchDir>/e2e/<worker>-<seq>/`.

- Always: `trace.jsonl`, `screenshots/`.
- On failure: `failure.png`, `screen-at-failure.txt`, plus `console.jsonl` and `network.jsonl` with devtools.
- `<out>/results.jsonl`: one line per test, status `passed | failed | skipped | timed-out`.
- Read `screen-at-failure.txt` first: it is the full AX tree at the failure.

## From a recording

1. `warden ui record start <name>`, drive the app, `warden ui record stop`.
2. `warden ui export .warden-ui/<name>.flow.json --to e2e/<name>.e2e.ts --ids e2e/helpers/ids.ts` (`--force` overwrites). New ids merge into `ids` in camelCase (`sign-in-submit` becomes `signInSubmit`).
3. Resolve every `FIXME`. The generated code throws on them.
4. Run it by hand, then add the flow to the suite's `flows` with `entries`.

## Not in the API

These do not exist. Do not write them.

- `app.launch`, `app.openLink`, `app.reload` (use `app.open`, `device.openLink`, `device.devtools.reloadJs()`)
- `device.rotate` (use `device.orientation`)
- `toBeHittable`
- locator `scroll` / `scrollUntil` (use `locator.scrollTo()` or `screen.scrollUntilVisible()`)
- `agent.*`

## Don'ts

- No fixed sleeps. Use matchers, `waitFor`, `settle`, or a poll helper.
- No fixed Metro port and no hand-started Metro. `warden dev` and the suite's `metro` own it.
- No `WARDEN_*` exports for a suite run. `warden e2e` sets them.
- No `test.only` left in. Under `CI` it fails the run.
- No subpath imports.
- Do not replay a `.flow.json` as a test. Export it.
- No `page`, `agent-device`, `argent` or tester.army APIs.
