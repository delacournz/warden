import type { DemoDefinition } from "../../../scripts/demo/demo.types";

/**
 * Face ID on a leased simulator: status, open the real prompt, a wrong face,
 * the enrolled face, then the screen reads "Unlocked". Every line shown is a
 * command that ran; every output line is what the phone visibly did.
 */
export const demo: DemoDefinition = {
	name: "biometrics-faceid",
	title: "Face ID, automated.",
	subtitle: "warden drives the real iOS prompt on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 · Face ID" },
	platform: "ios",
	claim: { biometrics: true },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://biometrics",
	},
	ready: ["id=bio-screen", "id=bio-unlock"],
	leadInMs: 1500,
	tailHoldMs: 4000,
	outro: "# real LocalAuthentication prompt · no app-side bypass",
	steps: [
		{
			argv: ["ui", "biometrics", "status"],
			output: { kind: "plain", text: "enrolled: true  modality: face" },
			pauseAfterMs: 2000,
		},
		{
			argv: ["ui", "press", "id=bio-unlock"],
			output: { kind: "ok", text: "pressed “Unlock with Face ID”" },
			pauseAfterMs: 2200,
		},
		{
			argv: ["ui", "biometrics", "fail"],
			output: { kind: "ok", text: "sent a non-matching face" },
			pauseAfterMs: 2800,
		},
		{
			argv: ["ui", "biometrics", "match"],
			output: { kind: "ok", text: "sent the enrolled face" },
			pauseAfterMs: 600,
		},
		{
			argv: ["ui", "wait", "text", "Unlocked", "--timeout", "8000"],
			shown: 'warden ui wait text "Unlocked"',
			output: { kind: "ok", text: "found “Unlocked”" },
			pauseAfterMs: 0,
		},
	],
};
