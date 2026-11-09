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
