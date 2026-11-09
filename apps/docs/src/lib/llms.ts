import { githubUrl, siteUrl } from "./shared";

/**
 * The top of `/llms.txt` (llmstxt.org): what warden is and the first commands an agent runs, so an
 * agent that reads only this file can install warden, drive a simulator and run a saved spec.
 * Every command here is quoted from `skills/warden`; keep it in step with the skill.
 */
const HEADER = `# warden

> warden is an end-to-end (E2E) testing framework and simulator manager for Expo (React Native) apps, built for AI coding agents. Agents write \`*.e2e.ts\` specs in TypeScript (npm \`@delacour/warden-e2e\`), and the \`warden\` CLI (npm \`@delacour/warden\`) runs them in parallel on iOS simulators and Android emulators it leases, so every agent and worktree on one Mac gets its own device, port and app build without colliding. \`warden e2e\` needs an Expo app; a bare React Native app can use \`warden dev\` and \`warden ui\` today.

## Task: add E2E tests to an Expo (React Native) app

\`warden e2e\` needs an Expo app (Expo SDK, including a prebuilt / dev-client Expo project). Check \`package.json\` for an \`expo\` dependency first. A bare React Native app (only \`react-native\`) cannot run \`warden e2e\` yet: stop and tell the user, and offer \`warden dev\` (Metro + the app on a leased simulator) and \`warden ui\` (drive the app by hand): ${siteUrl}/docs/sims/dev.md and ${siteUrl}/docs/sims/ui.md

Run these in the Expo app's repo. Full page with a copy-paste prompt: ${siteUrl}/docs/e2e/add-to-existing-app.md

1. Install and wire the agent: \`bunx @delacour/warden install\` (or \`npx @delacour/warden install\`), then \`warden doctor\`.
2. Read the rules: \`warden skill show\`.
3. Scaffold: \`warden init --bundle-id <id>\` writes \`warden.config.ts\` and \`e2e/smoke.e2e.ts\`; install the packages it names.
4. Add the spec API at warden's version: \`bun add -d @delacour/warden-e2e@<warden version>\` (the version \`warden --version\` prints).
5. Add \`testID\` and \`accessible\` to every element the flow touches.
6. Write a spec, a \`*.e2e.ts\` file such as \`e2e/<flow>.e2e.ts\`:\`import { expect, test } from "@delacour/warden-e2e"\`, open with \`app.open()\`, act with \`screen.getByTestId("...").tap()\`, assert with \`await expect(...).toBeVisible()\`.
7. Declare the suite under \`e2e\` in \`warden.config.ts\` (\`project\`, \`specsDir\`, \`platform\`, \`count\`).
8. Run it: \`warden e2e <suite>\` (\`--count 3\` for three simulators). On a failure read \`screen-at-failure.txt\` in the batch dir.
9. CI: run \`warden e2e <suite>\` on a macOS runner, see ${siteUrl}/docs/e2e/ci.md

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

/** A recorded clip `<DemoTabs>` can show: see `DEVICE_CONTROL.clips`. */
export type DemoClipRef = { id: string; title: string; src: string };

const demoTag = /<(DemoClip|DemoReel|DemoTabs)\b([^>]*?)\s*\/>/g;

const entities: Record<string, string> = { "&#x22;": '"', "&quot;": '"', "&#x27;": "'", "&amp;": "&" };

function attributes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, name, value] of raw.matchAll(/(\w+)="([^"]*)"/g)) {
		if (name && value !== undefined) out[name] = value.replace(/&#x22;|&quot;|&#x27;|&amp;/g, (e) => entities[e] ?? e);
	}
	return out;
}

function videoLink(label: string, src: string): string {
	return `[Video: ${label}](${siteUrl}${src}.mp4)`;
}

/**
 * The page's demo components as Markdown links to their `.mp4`. The processed Markdown keeps them as JSX, and a
 * crawler reading the `.md` twin or `/llms-full.txt` took `src="/demos/a11y/audit"` for a URL: a 404, since the
 * files sit at `<src>.mp4` / `.jpg`.
 */
export function demosAsMarkdown(markdown: string, clips: readonly DemoClipRef[]): string {
	return markdown.replace(demoTag, (tag, name: string, raw: string) => {
		const attrs = attributes(raw);
		if (name === "DemoTabs") {
			const ids: unknown = JSON.parse(attrs.ids ?? "[]");
			if (!Array.isArray(ids)) return "";
			return ids
				.flatMap((id) => clips.filter((clip) => clip.id === id))
				.map((clip) => `- ${videoLink(clip.title, clip.src)}`)
				.join("\n");
		}
		const { src, label } = attrs;
		if (!src || !label) return tag;
		const link = videoLink(label, src);
		return name === "DemoReel" && attrs.command && attrs.facts
			? `${link} (\`${attrs.command}\`: ${attrs.facts})`
			: link;
	});
}
