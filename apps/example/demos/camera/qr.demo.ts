import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * The simulated camera on a leased simulator: a QR image becomes the app's real camera feed (expo-camera preview),
 * the app's own scanner decodes it, then `camera clear` removes the feed. Every output line is what the phone did.
 */
export const demo: DemoDefinition = {
	name: "camera/qr",
	title: "Point the camera at anything.",
	subtitle: "warden feeds an image into the app's real camera on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · camera" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://camera",
		appearance: "dark",
	},
	setup: [
		["ui", "camera", "set", "demos/camera/scene.mov"],
		["ui", "open", "nz.co.delacour.warden.example", "--relaunch"],
		["ui", "open", "warden-example://camera", "--settle"],
		{ argv: ["ui", "press", "id=camera-allow", "--settle"], optional: true },
		{ argv: ["ui", "alert", "accept", "--settle"], optional: true },
	],
	ready: ["id=camera-screen", "id=camera-ready"],
	leadInMs: 1500,
	tailHoldMs: 6000,
	outro: "# real expo-camera preview · nothing mocked in the app",
	steps: [
		{
			argv: ["ui", "camera", "set", "demos/camera/qr-hello.png"],
			shown: "warden ui camera set qr-hello.png",
			output: { kind: "ok", text: "QR image is now the camera feed" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "hello", "--timeout", "10000"],
			shown: 'warden ui wait text "hello"',
			output: { kind: "ok", text: "qr readout filled: “hello”" },
			pauseAfterMs: 3500,
		},
		{
			argv: ["ui", "camera", "clear"],
			hidden: true,
			output: { kind: "plain", text: "feed cleared" },
			pauseAfterMs: 0,
		},
	],
};
