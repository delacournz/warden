import { gitConfig } from "./shared";

/**
 * The privacy policy, as data.
 *
 * Every claim here is about code somewhere else in the repository: a package
 * the site installs, a host the CLI fetches from, an event the server sends.
 * It lives apart from the page that renders it so `privacy.test.ts` can read
 * it, and hold each disclosure that names a package to the package being
 * installed, and each installed package known to phone home to a disclosure
 * naming it.
 *
 * Inline code and links use two marks, `` `code` `` and `[text](url)`, which
 * `rich-text.tsx` renders.
 *
 * Change `updated` with anything a reader would care about. The file's history
 * is public and the page links to it, which is the changelog.
 */

/** One thing that leaves a device, or stays on it. */
export type Disclosure = {
	/** What is sent or stored, in the reader's words. */
	what: string;
	/** Who receives it: a company, our own server, or the reader's own device. */
	to: string;
	/** Why, and for how long where that is known. */
	why: string;
	/** The `apps/docs` dependency that sends it, when one does. `privacy.test.ts` holds it to `package.json`. */
	source?: { package: string };
};

export type PrivacySection = {
	/** The anchor, so a link can land on one section. */
	id: string;
	title: string;
	/** Prose before the table. */
	body: readonly string[];
	disclosures?: readonly Disclosure[];
	/** Prose after the table. */
	after?: readonly string[];
};

const CONTACT = "chris@delacour.co.nz";
const MAIL = `[${CONTACT}](mailto:${CONTACT})`;
const HISTORY = `https://github.com/${gitConfig.user}/${gitConfig.repo}/commits/${gitConfig.branch}/apps/docs/src/lib/privacy.ts`;

export const PRIVACY = {
	updated: "2026-10-25",
	controller: "Delacour Limited",
	contact: CONTACT,
	title: "Privacy policy",
	description:
		"What the warden website and command-line tool send, where it goes and why. No accounts, no adverts, no tracking across other sites.",
	lede: "warden is a command-line tool that leases simulators to coding agents, and this site documents it. Neither has accounts, adverts or tracking across other companies' sites. This page lists everything that leaves your device, where it goes and why.",
	glance: [
		"No accounts, sign-in or profiles. Nothing we receive has your name or email address on it.",
		"No adverts, no tracking across other companies' sites, and nothing is sold.",
		"The website counts visits with PostHog without cookies. PostHog sets a cookie and records your session only if you accept.",
		"The `warden` CLI sends nothing about you. It talks to npm and GitHub only to update itself.",
		"Your settings, the site's light or dark choice and your answer to the cookie banner, stay on your device.",
	],
} as const;

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
	{
		id: "who-we-are",
		title: "Who we are",
		body: [
			`${PRIVACY.controller}, a company registered in New Zealand, runs \`warden.delacour.co.nz\` and the \`warden\` command-line tool, and is responsible for the personal information they handle. Write to ${MAIL} about anything on this page.`,
			"This page covers warden only. The studio site, `delacour.co.nz`, has [its own policy](https://delacour.co.nz/privacy).",
		],
	},
	{
		id: "the-website",
		title: "The website",
		body: [
			"`warden.delacour.co.nz` counts visits with PostHog, reached through our own address, `i.delacour.co.nz`. Until you choose Accept in the banner, PostHog stores nothing on your device and counts you without cookies. Choose Accept and PostHog keeps an identifier in a cookie and your browser's local storage, so a later visit is recognised as yours, and records your session: the pages you see, where you click and scroll, and what you type into search. Anything typed into a form field is masked before it leaves your browser.",
			"The site's fonts are served from our own address, so loading a page involves only the parties below.",
		],
		disclosures: [
			{
				what: "Each request: your IP address, your browser's user agent, the address of the page and the time",
				to: "Railway, which hosts the site",
				why: "To serve the page and keep the site running. Railway keeps these request logs for a limited period set by its plan.",
			},
			{
				what: "What you type into search, once you stop typing, and how many pages it found",
				to: "Our own server to answer it, and PostHog to count it",
				why: "Answered from an index held in memory, which does not log it. The query and its result count go to PostHog so we can see what people look for and what the docs are missing. Do not type anything personal into it.",
			},
			{
				what: "The pages you visit and what you do on them: where you click and move the mouse and how far you scroll, links you follow to other sites, files you open such as `llms.txt`, and when you copy a command, a prompt or a code sample; the page you came from, your browser, operating system, device type, screen size and language, and your IP address",
				to: "PostHog, through our reverse proxy at `i.delacour.co.nz`",
				why: "To count visits, see how people use the docs and draw heatmaps of where they click. PostHog uses your IP address to work out an approximate location and, until you accept, to count you with a hash that changes every day instead of a cookie. If you accept, it also stores a random identifier in a cookie and in local storage (`ph_…`) that recognises your browser on a later visit; decline later and it deletes them.",
				source: { package: "posthog-js" },
			},
			{
				what: "Only if you accept: a recording of your visit, as the page's structure and your clicks, scrolling and typing over time, with every form field masked",
				to: "PostHog, through our reverse proxy at `i.delacour.co.nz`",
				why: "To watch how a reader moves through the docs and where they get stuck. Nothing is recorded until you choose Accept, and choosing Decline later stops it. The recording is of this site only.",
			},
			{
				what: "When a program rather than a browser reads `llms.txt`, `llms-full.txt` or a documentation page's Markdown: the address read and the program's user agent, for example `ClaudeBot/1.0` or `curl/8.7.1`",
				to: "PostHog, sent by our own server",
				why: "Coding agents run no scripts and see no banner, so our server counts these reads itself. It sends no IP address; PostHog sees only our server's.",
			},
			{
				what: "Your light or dark choice, and your answer to the cookie banner",
				to: "Your browser's local storage",
				why: "So the site remembers them. They are never sent to us.",
			},
		],
		after: [
			"A documentation page's Open menu can send that page to ChatGPT, Claude or another assistant. Nothing is sent unless you choose one, and then that service's own policy applies.",
		],
	},
	{
		id: "the-cli",
		title: "The command-line tool",
		body: [
			"The `warden` CLI collects no telemetry and has no account. It runs on your own Mac or CI runner, and the only requests it makes beyond your machine are the ones below.",
		],
		disclosures: [
			{
				what: "A version check and, if you update, a download: your IP address and the package requested",
				to: "npm, `registry.npmjs.org`, or whichever registry your package manager uses",
				why: "`warden update` asks the registry for the latest version and downloads it. The check runs only when you run the command.",
			},
			{
				what: "A download of the simulator helper: your IP address and the release asset requested",
				to: "GitHub, `github.com/delacournz/warden/releases`",
				why: "`warden update` and `warden doctor --fetch-helper` fetch the native helper that drives iOS simulators, and check it against the release's published checksum.",
			},
			{
				what: "Simulator, emulator and app traffic",
				to: "Apple's and Google's tooling on your own machine, and your own app's servers",
				why: "warden runs `simctl`, `adb` and your app's dev server locally. What your app sends while it runs is governed by your app, not by warden.",
			},
			{
				what: "Leases, device records, build caches and e2e evidence",
				to: "Your own machine, under `~/.warden`",
				why: "So every agent and shell on the machine claims from one registry, and a failed spec leaves a screenshot and the screen tree to read. Delete the folder at any time.",
			},
		],
		after: [
			"`warden install` edits the configuration of the coding agents it finds on your machine, after showing a diff and asking. Those edits stay on your machine. What an agent then sends to its own provider is governed by that provider's policy.",
		],
	},
	{
		id: "who-else",
		title: "Who else handles it",
		body: [
			"The companies above process this information for us under their own terms. They are based in the United States, so it is processed there:",
			"[Railway](https://railway.com/legal/privacy) for hosting the website, [PostHog](https://posthog.com/privacy) for the website's visit counts and recordings, [npm](https://docs.npmjs.com/policies/privacy) for the CLI's updates, and [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) for the helper download.",
			"We do not sell or rent anything to anyone, and we do not share it with anyone else unless the law requires us to.",
		],
	},
	{
		id: "why",
		title: "Why we use it",
		body: [
			"Only to run the website and the CLI, to count how many people use them, to see which pages and searches get used and where readers get stuck, and to fix what breaks. We do not combine it with anything else, and we do not use it to identify, profile or advertise to anyone.",
			"If UK or EU data protection law applies to you, our lawful basis is our legitimate interest in running and improving these services, which we have weighed against your interests given how little is collected. That covers PostHog's cookieless counting. For PostHog's cookie, local storage and session recording, it is your consent, which you can withdraw at any time from Cookie settings at the foot of the home page.",
		],
	},
	{
		id: "how-long",
		title: "How long it is kept",
		body: [
			"What stays on your device is there until you clear it. Railway, PostHog, npm and GitHub keep what they receive for the periods their own policies set, linked above.",
		],
	},
	{
		id: "your-rights",
		title: "Your rights",
		body: [
			`Under New Zealand's Privacy Act 2020 you can ask to see personal information we hold about you and to have it corrected. If you are in the UK or the EU you can also ask us to delete it, to restrict or object to how it is used, or to give you a copy. Write to ${MAIL}.`,
			"Nothing we receive has your name on it, so we may not be able to find information about you in particular. Declining in the cookie banner is the surest way to stop a recording.",
			"If you are unhappy with how we have handled a request, you can complain to New Zealand's [Office of the Privacy Commissioner](https://www.privacy.org.nz), the UK's [Information Commissioner's Office](https://ico.org.uk/make-a-complaint/) or the data protection authority where you live.",
		],
	},
	{
		id: "children",
		title: "Children",
		body: [
			"warden is a tool for software developers and is not directed at children. We do not knowingly collect information from anyone under 16.",
		],
	},
	{
		id: "changes",
		title: "Changes to this page",
		body: [
			`When this page changes, the date at the top changes with it. Every earlier version is public in [the repository's history](${HISTORY}).`,
		],
	},
];
