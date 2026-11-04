import { githubUrl, siteUrl } from "./shared";

/**
 * The top of `/llms.txt` (llmstxt.org): what warden is and the first commands an agent runs, so an
 * agent that reads only this file can install warden, drive a simulator and run a saved spec.
 * Every command here is quoted from `skills/warden`; keep it in step with the skill.
 */
const HEADER = `# warden

> Every agent gets its own simulator. warden is a CLI (npm \`@delacour/warden\`) and a TypeScript e2e framework (npm \`@delacour/warden-e2e\`) that leases iOS simulators, Android emulators, ports and app builds across every worktree on one Mac, so parallel coding agents build, run, drive and test a React Native, Expo or native app without colliding.

## Start here (agents)

1. Install: \`bunx @delacour/warden install\` (or \`npx @delacour/warden install\`), then \`warden doctor\`.
2. Read the rules and follow them: \`warden skill show\`.
3. Claim a device: \`warden claim ios --json\` (or \`android\`) and pass the returned udid / serial on every call. Never touch a device you did not claim.
4. Drive the app by hand: \`warden ui open <bundleId> --udid $UDID\` → \`warden ui snapshot -i --udid $UDID\` → \`warden ui press @e3 --udid $UDID\` → \`warden ui close --release --udid $UDID\`.
5. Keep a check: write a \`*.e2e.ts\` spec importing \`@delacour/warden-e2e\`, run it with \`warden e2e <suite>\`.

## Key facts

- Free and open source, MIT. Runs on your own Mac or CI runner: no account, no cloud.
- iOS simulators need macOS with Xcode; Android emulators need the Android SDK. Plugged-in phones are opt-in with \`--physical\`.
- Targets Expo and React Native for builds, the dev client and Metro; \`warden ui\` and specs drive any installed app by bundle id.
- The skill installs into Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode, Windsurf and Zed; Claude Code and Codex also get a SessionEnd hook that releases what a session leased.
- \`warden mcp\` serves a \`warden dev\` session's Metro output, console, network and profiles over stdio.

## Links

- Site: ${siteUrl}
- Source: ${githubUrl}
- CLI on npm: https://www.npmjs.com/package/@delacour/warden
- Spec API on npm: https://www.npmjs.com/package/@delacour/warden-e2e
- Issues: ${githubUrl}/issues

Every docs page below is also Markdown at its URL plus \`.md\` (or send \`Accept: text/markdown\`). All pages in one file: ${siteUrl}/llms-full.txt

## Docs
`;

/** Fumadocs' page index (`llms(source).index()`) under the agent header, its own H1 dropped. */
export function llmsIndex(index: string): string {
	const pages = index.replace(/^# [^\n]*\n+/, "");
	return `${HEADER}\n${pages}`;
}
