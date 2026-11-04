import type { DevDemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * A spec with a wrong testID (`sign-in-emial`), written to `e2e/debug-demo.e2e.ts` for the take and removed by a shell
 * trap, run with `warden e2e` on a simulator it claims itself (`--label`). Then the evidence it left: the lines of
 * `screen-at-failure.txt` that mention `sign-in`, which show the real id (`sign-in-email`). The commands are real under
 * a PTY (a script prints the prompt lines). Output lines are cut to the terminal width with `cut` (long paths); the
 * artifacts directory is found from the run's own output and entered before the `grep`. `WARDEN_HEADLESS=1` keeps
 * Simulator.app's window from opening. The simulator is recorded with `simctl recordVideo` (`rawVideo`), because
 * warden's video helper and `warden e2e` cannot share a device. The failed run leaves its simulator booted for
 * inspection; the take deletes it.
 */
export const demo: DevDemoDefinition = {
	name: "debug/failure",
	platform: "ios",
	claim: {},
	app: { bundleId: "nz.co.delacour.warden.example", project: "apps/example" },
	devArgs: [],
	devEnv: { WARDEN_HEADLESS: "1" },
	rawVideo: true,
	script: [
		"cat > e2e/debug-demo.e2e.ts <<'SPEC'",
		'import { expect, test } from "@delacour/warden-e2e";',
		'import { openSignIn, SPEC_OPTIONS } from "./helpers/steps";',
		"",
		"test.use(SPEC_OPTIONS);",
		"",
		'test("the sign-in screen has an email field", async ({ app, screen }) => {',
		"	await openSignIn(app, screen);",
		'	await expect(screen.getByTestId("sign-in-emial")).toBeVisible();',
		"});",
		"SPEC",
		'SPEC_FILE="$PWD/e2e/debug-demo.e2e.ts"',
		"trap 'rm -f \"$SPEC_FILE\"' EXIT INT TERM HUP",
		'OUT=$(mktemp)',
		"printf '\\033[2m$\\033[0m warden e2e example --specs debug-demo --label {label}\\n'",
		'warden e2e example --specs debug-demo --label {label} 2>&1 | tee "$OUT" | cut -c1-118',
		"ART=$(grep -o 'artifacts [^ ]*' \"$OUT\" | head -1 | cut -d' ' -f2)",
		'cd "$ART"',
		"printf '\\n\\033[2m$\\033[0m grep sign-in screen-at-failure.txt\\n'",
		"grep sign-in screen-at-failure.txt | sed 's/^ *//'",
	].join("\n"),
	uninstallFirst: false,
	cols: 120,
	rows: 34,
	terminalTitle: "zsh — apps/example",
	footer: { left: "", right: "warden.co.nz · real simulator · not an animation" },
	tailHoldMs: 4000,
	posterBeat: "evidence",
	beats: [
		{ id: "start", caption: "warden e2e: leases a simulator, installs the build, runs the spec", timeoutMs: 1000, pauseAfterMs: 0 },
		{
			id: "run",
			caption: "the spec fails: expect(getByTestId(\"sign-in-emial\")) found nothing",
			waitScreen: "gate failed",
			timeoutMs: 300_000,
			pauseAfterMs: 1500,
		},
		{
			id: "evidence",
			caption: "screen-at-failure.txt: the screen's real ids. It is sign-in-email, not sign-in-emial",
			waitScreen: "id=sign-in-screen",
			timeoutMs: 20_000,
			pauseAfterMs: 5000,
		},
		{ id: "done", caption: "fix the id in the spec (or add the missing testID to the component), not with retries", stopVideoFirst: true, timeoutMs: 5000, pauseAfterMs: 300 },
	],
};
