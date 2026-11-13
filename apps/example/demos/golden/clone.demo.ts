import type { DevDemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * `warden golden ensure` (the golden image is warm, so it is reused), then `warden claim ios`: no free simulator is
 * left, so warden clones the golden image into a fresh device and boots it while the simulator video runs. The two
 * commands are the real CLI under a PTY (a script prints the prompt lines); the video starts as soon as the clone
 * has a udid, so the phone is seen booting. The device is the take's lease (`demo-golden-clone`) and is released
 * with `--shutdown` afterwards (an ephemeral sim is deleted on shutdown, so the next take clones again).
 * `WARDEN_HEADLESS=1` keeps Simulator.app's window from opening; it changes nothing on screen.
 */
export const demo: DevDemoDefinition = {
	name: "golden/clone",
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: { bundleId: "nz.co.delacour.warden.example", project: "apps/example" },
	devArgs: [],
	devEnv: { WARDEN_HEADLESS: "1" },
	script: [
		"printf '\\033[2m$\\033[0m warden golden ensure --profile iphone-17-pro\\n'",
		"warden golden ensure --profile iphone-17-pro",
		"printf '\\n\\033[2m$\\033[0m warden claim ios --profile iphone-17-pro --label {label}\\n'",
		"warden claim ios --profile iphone-17-pro --label {label}",
	].join("\n"),
	uninstallFirst: false,
	cols: 100,
	rows: 20,
	terminalTitle: "zsh — apps/example",
	footer: { left: "", right: "warden.co.nz · real simulator · not an animation" },
	tailHoldMs: 2500,
	posterBeat: "home",
	beats: [
		{ id: "start", caption: "warden golden ensure: the golden image is warm", timeoutMs: 1000, pauseAfterMs: 0 },
		{
			id: "claimed",
			caption: "warden claim ios: clones the golden image and boots the clone",
			waitScreen: "claimed warden-iphone",
			timeoutMs: 120_000,
			pauseAfterMs: 500,
		},
		{ id: "home", caption: "the clone's home screen: booted and ready", waitBoot: true, ramp: 3, timeoutMs: 120_000, pauseAfterMs: 4000 },
		{ id: "done", caption: "a booted, ready simulator, leased to this session", stopVideoFirst: true, timeoutMs: 5000, pauseAfterMs: 300 },
	],
};
