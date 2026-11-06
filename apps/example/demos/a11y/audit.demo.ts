import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * Accessibility on a leased simulator: the bad variant of the screen is opened and audited (limited to the
 * `role-in-name` rule, a warning, so the audit prints its finding and exits 0 for the kit), then the good variant
 * passes the full audit and the text size grows. Output lines are what the command printed or the phone did.
 */
export const demo: DemoDefinition = {
	name: "a11y/audit",
	title: "Audit the screen.",
	subtitle: "warden finds accessibility issues and changes text size on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · accessibility" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://a11y",
		appearance: "dark",
	},
	ready: ["id=a11y-screen"],
	leadInMs: 1500,
	tailHoldMs: 3500,
	outro: "# real accessibility tree · issues found, not mocked",
	steps: [
		{
			argv: ["ui", "open", "warden-example://a11y?bad=1", "--settle"],
			shown: "warden ui open warden-example://a11y?bad=1",
			output: { kind: "ok", text: "opened ?bad=1 (extra controls below)" },
			pauseAfterMs: 800,
		},
		{
			argv: ["ui", "scroll", "down", "--until", "id=a11y-bad-role"],
			output: { kind: "ok", text: "scrolled to the broken controls" },
			pauseAfterMs: 1000,
		},
		{
			argv: ["ui", "a11y", "audit", "--rule", "role-in-name"],
			output: { kind: "plain", text: "flagged “Submit button” (role in name)" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "open", "warden-example://a11y", "--settle"],
			shown: "warden ui open warden-example://a11y",
			output: { kind: "ok", text: "opened the good screen again" },
			pauseAfterMs: 800,
		},
		{
			argv: ["ui", "a11y", "audit", "--no-native"],
			output: { kind: "ok", text: "audit passed" },
			pauseAfterMs: 1500,
		},
		{
			argv: ["ui", "a11y", "set", "--text-size", "accessibility-large", "--bold"],
			output: { kind: "ok", text: "text grew and went bold" },
			pauseAfterMs: 2500,
		},
	],
};
