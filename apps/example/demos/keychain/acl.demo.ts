import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * A Keychain item bound to the current Face ID on a leased simulator with warden's Keychain ACL shim on: the app's
 * plain `SecItemCopyMatching` brings up the real Face ID sheet, a match hands the secret back, and after a
 * re-enrolment the same read is refused with no prompt, as on a phone. The app never calls `evaluatePolicy` itself.
 * Every line shown is a command that ran; every output line is what the phone visibly did.
 */
export const demo: DemoDefinition = {
	name: "keychain/acl",
	title: "Keychain Face ID, enforced.",
	subtitle: "Simulators skip Keychain access control. warden puts the prompt back.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 · Face ID" },
	platform: "ios",
	claim: { biometrics: true },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://keychain",
		appearance: "dark",
	},
	setup: [["ui", "open", "nz.co.delacour.warden.example", "--keychain-acl"]],
	ready: ["id=kc-screen", "id=kc-save-bio"],
	leadInMs: 1500,
	tailHoldMs: 4000,
	outro: "# the app only reads its Keychain item · no bypass",
	steps: [
		{
			argv: ["ui", "press", "id=kc-save-bio"],
			output: { kind: "ok", text: "saved an item tied to this Face ID" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "press", "id=kc-read-bio"],
			output: { kind: "ok", text: "the read brought up the Face ID sheet" },
			pauseAfterMs: 2400,
		},
		{
			argv: ["ui", "biometrics", "match"],
			output: { kind: "ok", text: "sent the enrolled face" },
			pauseAfterMs: 400,
		},
		{
			argv: ["ui", "wait", "text", "warden-secret", "--timeout", "8000"],
			shown: 'warden ui wait text "warden-secret"',
			output: { kind: "ok", text: "the Keychain returned the secret" },
			pauseAfterMs: 2000,
		},
		{
			argv: ["ui", "biometrics", "reenroll"],
			output: { kind: "plain", text: "new Face ID enrolment" },
			pauseAfterMs: 1200,
		},
		{
			argv: ["ui", "press", "id=kc-read-bio"],
			output: { kind: "ok", text: "no prompt: Invalidated, -25300" },
			pauseAfterMs: 0,
		},
	],
};
