import type { DevDemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * The landing hero: warden's real `warden dev` dashboard beside the simulator it claims itself (`--label`, found in
 * `warden ls`; the video starts once the udid is known). The dev build is installed from the cache (the app is
 * uninstalled first), Metro starts, the dev client opens, one visible string in
 * `src/app/welcome.tsx` is edited for real and hot-reloads on the phone (reverted afterwards), `h` shows the HUD, `q`
 * quits and releases the device and port. `EXPO_NO_DEPENDENCY_VALIDATION=1` drops Expo CLI's "update available / N
 * packages may need updating" nag from the Metro pane (`@expo/cli` `checkDependenciesOnStart`; it changes nothing
 * else). Everything runs in real time except a long dev client wait (6 s or more after the head and tail), which is
 * sped up 3x and tagged on screen.
 */
export const demo: DevDemoDefinition = {
	name: "dev/hero",
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: { bundleId: "nz.co.delacour.warden.example", project: "apps/example", appearance: "dark" },
	devArgs: ["--headless", "--no-shutdown"],
	devEnv: { EXPO_NO_DEPENDENCY_VALIDATION: "1" },
	uninstallFirst: true,
	cols: 100,
	rows: 26,
	terminalTitle: "warden dev ios — apps/example",
	footer: { left: "", right: "warden.co.nz · real simulator · not an animation" },
	tailHoldMs: 800,
	posterBeat: "hud",
	beats: [
		{ id: "start", caption: "warden dev ios: claims a device, installs the build, starts Metro", timeoutMs: 1000, pauseAfterMs: 0 },
		{
			id: "client",
			caption: "dev build from cache, then the dev client opens on the simulator",
			waitScreen: "✓ dev client",
			waitPhone: ["id=welcome-screen"],
			timeoutMs: 600_000,
			ramp: 3,
			pauseAfterMs: 3500,
		},
		{ id: "metro", caption: "select Metro: its own output", keys: "kkk", timeoutMs: 5000, pauseAfterMs: 1500 },
		{
			id: "edit",
			caption: "edit src/app/welcome.tsx: Metro rebuilds, the phone hot reloads",
			waitScreen: "›\\s+\\S+\\s+Metro",
			edit: {
				file: "apps/example/src/app/welcome.tsx",
				from: "A small Expo app built with Delacour UI, for testing warden end to end.",
				to: "Saved a file, no rebuild: this changed on the simulator live.",
			},
			afterPhone: ["text=/no rebuild/"],
			timeoutMs: 60_000,
			pauseAfterMs: 4000,
		},
		{ id: "hud", caption: "h: HUD on", keys: "h", timeoutMs: 5000, pauseAfterMs: 4000 },
		{ id: "quit", caption: "q: Metro stops, the device and port are released (warden ls shows none)", keys: "q", stopVideoFirst: true, timeoutMs: 5000, pauseAfterMs: 500 },
	],
};
