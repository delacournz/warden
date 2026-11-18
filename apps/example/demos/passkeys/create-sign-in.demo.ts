import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * Passkeys on a leased simulator: the example app's real `ASAuthorizationController` calls (react-native-passkey) are
 * answered by warden's virtual authenticator. Create, list, sign in (the app verifies the signature itself), then a
 * cancelled sign-in. Every output line is what the phone did.
 */
export const demo: DemoDefinition = {
	name: "passkeys/create-sign-in",
	title: "Passkeys, automated.",
	subtitle: "warden answers the app's real passkey calls on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · passkeys" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://passkeys",
		appearance: "dark",
	},
	setup: [
		["ui", "passkey", "set", "auto"],
		["ui", "open", "nz.co.delacour.warden.example", "--relaunch"],
		["ui", "open", "warden-example://passkeys", "--settle"],
	],
	ready: ["id=pk-screen", "id=pk-action"],
	leadInMs: 1500,
	tailHoldMs: 5000,
	outro: "# real ASAuthorizationController call · signature verified in the app",
	steps: [
		{
			argv: ["ui", "press", "id=pk-action", "--settle"],
			shown: "warden ui press id=pk-action",
			output: { kind: "ok", text: "Create passkey → Saved" },
			pauseAfterMs: 1200,
		},
		{
			argv: ["ui", "passkey", "list"],
			shown: "warden ui passkey list",
			output: { kind: "plain", text: "1 passkey · warden.co.nz · demo@warden.co.nz" },
			pauseAfterMs: 1500,
		},
		{
			argv: ["ui", "press", "id=pk-action", "--settle"],
			shown: "warden ui press id=pk-action",
			output: { kind: "ok", text: "Sign in with passkey" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Signed in", "--timeout", "10000"],
			shown: 'warden ui wait text "Signed in"',
			output: { kind: "ok", text: "signature verified · uv true" },
			pauseAfterMs: 2000,
		},
		{
			argv: ["ui", "passkey", "set", "cancel"],
			shown: "warden ui passkey set cancel",
			output: { kind: "ok", text: "next passkey call: the user cancels" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "press", "id=pk-action", "--settle"],
			hidden: true,
			output: { kind: "plain", text: "signed out" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "press", "id=pk-action", "--settle"],
			hidden: true,
			output: { kind: "plain", text: "sign in again" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Cancelled", "--timeout", "10000"],
			shown: 'warden ui wait text "Cancelled"',
			output: { kind: "ok", text: "Cancelled · UserCancelled" },
			pauseAfterMs: 2500,
		},
	],
};
