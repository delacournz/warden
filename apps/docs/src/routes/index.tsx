import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement, ReactNode } from "react";
import { CopyBlock } from "@/components/copy-block";
import { InstallCommand } from "@/components/install-command";
import { ClipTabs } from "@/components/landing/clip-tabs";
import { DemoVideo } from "@/components/landing/demo-video";
import { GlitchWord } from "@/components/landing/glitch-word";
import { RichText } from "@/components/rich-text";
import { WardenIcon } from "@/components/warden-icon";
import { ANALYTICS } from "@/lib/analytics/config";
import { CONSENT_OPEN_EVENT } from "@/lib/analytics/consent";
import {
	BOARD_COPY,
	CLOSING,
	type Claim,
	DEVICE_CONTROL,
	FAQ,
	type Feature as FeatureData,
	FIRST_PROMPT,
	HERO,
	HOW_IT_WORKS,
	ON_THE_DEVICE,
	SAFE_BY_DEFAULT,
	type Step as StepData,
	USE_CASES,
	WHAT_YOU_GET,
} from "@/lib/landing.data";
import { baseOptions } from "@/lib/layout.shared";
import { canonicalLink, softwareApplicationJsonLd, tagline } from "@/lib/seo";
import { appDescription, appName, githubUrl, pricingRoute, privacyRoute, termsRoute } from "@/lib/shared";

export const Route = createFileRoute("/")({
	component: Home,
	head: () => ({
		meta: [
			{ title: `${appName} — ${tagline}` },
			{ name: "description", content: appDescription },
			{ property: "og:url", content: canonicalLink("/").href },
		],
		links: [canonicalLink("/")],
		scripts: [{ type: "application/ld+json", children: JSON.stringify(softwareApplicationJsonLd()) }],
	}),
});

const PAGE = "mx-auto w-full max-w-6xl px-4 sm:px-6";

/** The one display voice: Mona Sans at full width and heavy weight. */
const DISPLAY = "tracking-[-0.035em] [font-variation-settings:'wdth'_125,'wght'_800]";

/** Agents with a real install path: the skill via the `skills` CLI, and the SessionEnd hook for two of them. */
const AGENTS: readonly { name: string; mark: string; hook: boolean }[] = [
	{ name: "Claude Code", mark: "claude", hook: true },
	{ name: "Codex", mark: "openai", hook: true },
	{ name: "Cursor", mark: "cursor", hook: false },
	{ name: "GitHub Copilot", mark: "githubcopilot", hook: false },
	{ name: "Gemini CLI", mark: "googlegemini", hook: false },
	{ name: "OpenCode", mark: "opencode", hook: false },
	{ name: "Windsurf", mark: "windsurf", hook: false },
	{ name: "Zed", mark: "zedindustries", hook: false },
];

/**
 * Illustrative: five agents on one Mac, each row what warden leases to it. Three worktrees share a
 * native fingerprint, so one cached build serves them; the fifth claim waits for a boot slot.
 */
const BOARD: readonly {
	agent: string;
	worktree: string;
	device: string;
	port: string;
	build: string;
	state: "leased" | "queued";
}[] = [
	{
		agent: "Claude Code",
		worktree: "feature/checkout",
		device: "iPhone 17",
		port: ":8081",
		build: "3f9a1c · cache",
		state: "leased",
	},
	{
		agent: "Codex",
		worktree: "fix/login-crash",
		device: "iPhone 17",
		port: ":8082",
		build: "3f9a1c · cache",
		state: "leased",
	},
	{
		agent: "Cursor",
		worktree: "feature/dark-mode",
		device: "Pixel 9 emulator",
		port: ":8083",
		build: "b72e04 · local",
		state: "leased",
	},
	{
		agent: "you",
		worktree: "main",
		device: "iPhone 17 Pro",
		port: ":8084",
		build: "3f9a1c · installed",
		state: "leased",
	},
	{ agent: "Gemini CLI", worktree: "feature/search", device: "next boot slot", port: "—", build: "—", state: "queued" },
];

/** Measured on Salient's 37 offline specs, iPhone 17 simulators, Oct 2026: job phase after the serve step is ready. */
const RUNS = [
	{ label: "1 simulator", time: "13m55s", seconds: 835 },
	{ label: "5 simulators", time: "3m25s", seconds: 205 },
] as const;

/**
 * The landing, told around one promise: every agent gets its own simulator. The hero with one install command and the
 * recorded run, the agents it works with, how it works in three commands, the lease board (five agents on one Mac),
 * what the leasing gives you, what an agent does on its device (run, drive, debug, keep, run the suite), the device
 * conditions as recorded clips, what warden will and won't touch, the first prompt, use cases, the FAQ and a closing
 * install. Every claim is data in `landing.data.ts`, held to the code by `landing.test.ts`.
 */
function Home(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className="flex flex-1 flex-col pb-24">
				<section className={`${PAGE} flex flex-col items-center gap-8 pt-16 text-center sm:pt-24`}>
					<a
						className="inline-flex items-center gap-2 rounded-full border border-hairline px-3 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
						href={githubUrl}
						rel="noreferrer noopener"
						target="_blank"
					>
						<span className="size-1.5 rounded-full bg-accent" />
						{HERO.pill}
					</a>
					<h1 className={`max-w-5xl text-balance text-[clamp(2.6rem,6.4vw,5.4rem)] text-ink leading-[0.95] ${DISPLAY}`}>
						Every <GlitchWord className="accent-voice text-accent">agent</GlitchWord> gets
						<br />
						its own{" "}
						<GlitchWord className="accent-voice text-accent" offset>
							simulator.
						</GlitchWord>
					</h1>
					<p className="max-w-2xl text-balance text-ink-2 text-lg leading-relaxed sm:text-xl">{HERO.lede}</p>
					<div className="flex w-full max-w-xl flex-col items-center gap-3">
						<InstallCommand className="w-full items-center text-start" setup />
						<p className="text-ink-2 text-sm">{HERO.installNote}</p>
					</div>
					<div className="flex flex-wrap justify-center gap-2">
						<PrimaryLink to="quickstart">Get started</PrimaryLink>
						<SecondaryAnchor href="#demo">Watch the demo</SecondaryAnchor>
					</div>
				</section>

				<section className={`${PAGE} scroll-mt-20 pt-16`} id="demo">
					<DemoVideo />
				</section>

				<section className={`${PAGE} flex flex-col items-center gap-10 pt-28 text-center`}>
					<h2 className={`text-[2rem] text-ink leading-none sm:text-[2.5rem] ${DISPLAY}`}>Works with</h2>
					<ul className="grid w-full max-w-4xl grid-cols-4 gap-y-8 sm:grid-cols-8">
						{AGENTS.map((agent) => (
							<li className="group flex flex-col items-center gap-3" key={agent.name}>
								<img
									alt=""
									className="size-9 opacity-85 transition-opacity group-hover:opacity-100 dark:invert"
									height={36}
									src={`/agents/${agent.mark}.svg`}
									width={36}
								/>
								<span className="font-mono text-[11px] text-ink-2 leading-tight">
									{agent.name}
									{agent.hook ? <span className="block text-accent-text">+hook</span> : null}
								</span>
							</li>
						))}
					</ul>
					<p className="max-w-xl text-ink-2 text-sm leading-relaxed">
						Every agent the skills CLI supports gets the warden skill. Claude Code and Codex also get a SessionEnd hook
						that releases what the session leased.
					</p>
				</section>

				<Section id="how-it-works" lede={HOW_IT_WORKS.lede} title={HOW_IT_WORKS.title}>
					<ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
						{HOW_IT_WORKS.steps.map((step) => (
							<Step key={step.n} step={step} />
						))}
					</ol>
				</Section>

				<Section lede={BOARD_COPY.lede} title={BOARD_COPY.title}>
					<LeaseBoard />
				</Section>

				<Section accent={WHAT_YOU_GET.accent} lede={WHAT_YOU_GET.lede} title={WHAT_YOU_GET.title}>
					<CardGrid cards={WHAT_YOU_GET.cards} columns="sm:grid-cols-2 lg:grid-cols-4" />
				</Section>

				<Section lede={ON_THE_DEVICE.lede} title={ON_THE_DEVICE.title}>
					<div className="flex flex-col gap-20 sm:gap-28">
						{ON_THE_DEVICE.features.map((feature, i) => (
							<Feature feature={feature} flip={i % 2 === 1} key={feature.label}>
								{feature.sample ? <Terminal code={feature.sample.code} label={feature.sample.label} /> : <RunChart />}
							</Feature>
						))}
					</div>
				</Section>

				<Section
					accent={DEVICE_CONTROL.accent}
					id="device-control"
					lede={DEVICE_CONTROL.lede}
					title={DEVICE_CONTROL.title}
				>
					<ClipTabs clips={DEVICE_CONTROL.clips} />
				</Section>

				<Section accent={SAFE_BY_DEFAULT.accent} lede={SAFE_BY_DEFAULT.lede} title={SAFE_BY_DEFAULT.title}>
					<CardGrid cards={SAFE_BY_DEFAULT.cards} columns="sm:grid-cols-2 lg:grid-cols-4" />
				</Section>

				<Section lede={FIRST_PROMPT.lede} title={FIRST_PROMPT.title}>
					<div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 text-start">
						<CopyBlock label="prompt" text={FIRST_PROMPT.prompt} />
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
							<AgentLink href="/llms.txt" note="every docs page, indexed">
								/llms.txt
							</AgentLink>
							<AgentLink href="/llms-full.txt" note="the whole docs in one file">
								/llms-full.txt
							</AgentLink>
							<AgentLink href="/docs/quickstart.md" note="any page, append .md">
								/docs/quickstart.md
							</AgentLink>
						</div>
					</div>
				</Section>

				<Section lede={USE_CASES.lede} title={USE_CASES.title}>
					<CardGrid cards={USE_CASES.cards} columns="sm:grid-cols-2 lg:grid-cols-3" />
				</Section>

				<Section lede={FAQ.lede} title={FAQ.title}>
					<div className="faq mx-auto flex w-full max-w-3xl flex-col border-hairline border-t text-start">
						{FAQ.items.map((item) => (
							<Faq key={item.q} q={item.q}>
								<RichText text={item.a} />
							</Faq>
						))}
					</div>
				</Section>

				<section className={`${PAGE} pt-28 sm:pt-36`}>
					<div className="flex flex-col items-center gap-8 rounded-[var(--radius-group)] border border-hairline bg-surface px-6 py-16 text-center sm:py-20">
						<h2 className={`max-w-3xl text-balance text-[clamp(2.2rem,5vw,4rem)] text-ink leading-[0.95] ${DISPLAY}`}>
							{CLOSING.title}
						</h2>
						<div className="flex w-full max-w-xl flex-col items-center gap-4">
							<InstallCommand className="w-full items-center text-start" setup />
							<div className="flex flex-wrap justify-center gap-2">
								<PrimaryLink to="quickstart">Read the quickstart</PrimaryLink>
								<SecondaryLink to="reference/cli">CLI reference</SecondaryLink>
							</div>
						</div>
					</div>
				</section>
			</main>
			<footer className="border-hairline border-t">
				<div className={`${PAGE} flex flex-wrap items-center gap-x-6 gap-y-2 py-8 font-mono text-[11px] text-ink-2`}>
					<span className="inline-flex items-center gap-2 font-sans font-semibold text-ink text-sm">
						<WardenIcon size={18} />
						warden
					</span>
					<Link className="hover:text-ink" params={{ _splat: "" }} to="/docs/$">
						docs
					</Link>
					<Link className="hover:text-ink" params={{ _splat: "reference/cli" }} to="/docs/$">
						cli
					</Link>
					<a className="hover:text-ink" href="/llms.txt">
						llms.txt
					</a>
					<a className="hover:text-ink" href={githubUrl} rel="noreferrer noopener" target="_blank">
						github
					</a>
					<Link className="hover:text-ink" to={pricingRoute}>
						pricing
					</Link>
					<Link className="hover:text-ink" to={termsRoute}>
						terms
					</Link>
					<Link className="hover:text-ink" to={privacyRoute}>
						privacy
					</Link>
					{ANALYTICS.posthog.kind === "on" ? (
						<button
							className="hover:text-ink"
							onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}
							type="button"
						>
							cookie settings
						</button>
					) : null}
					<a className="hover:text-ink sm:ms-auto" href="https://delacour.co.nz" rel="noopener" target="_blank">
						built by Delacour · MIT
					</a>
				</div>
			</footer>
		</HomeLayout>
	);
}

/**
 * A centered section: display heading, its last words in the accent when `accent` is given, one plain sentence under
 * it, then the content. `id` makes it a link target.
 */
function Section({
	title,
	accent,
	lede,
	id,
	children,
}: {
	title: string;
	accent?: string;
	lede: ReactNode;
	id?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<section className={`${PAGE} flex scroll-mt-20 flex-col gap-12 pt-28 sm:pt-36`} id={id}>
			<div className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
				<h2 className={`text-balance text-[clamp(2.2rem,4.6vw,3.6rem)] text-ink leading-[0.98] ${DISPLAY}`}>
					{title}
					{accent ? <span className="accent-voice text-accent"> {accent}</span> : null}
				</h2>
				<p className="max-w-2xl text-balance text-ink-2 text-lg leading-relaxed">{lede}</p>
			</div>
			{children}
		</section>
	);
}

/** One numbered step of how it works: the number, a title, one sentence and the command it is. */
function Step({ step }: { step: StepData }): ReactElement {
	return (
		<li className="flex flex-col gap-3 rounded-[var(--radius-group)] border border-hairline bg-surface p-6 text-start">
			<span className="font-mono text-accent-text text-xs tabular-nums">{step.n}</span>
			<h3 className="text-ink text-xl leading-tight tracking-[-0.02em] [font-variation-settings:'wdth'_120,'wght'_720]">
				{step.title}
			</h3>
			<p className="flex-1 text-ink-2 leading-relaxed">
				<RichText text={step.body} />
			</p>
			<code className="overflow-x-auto whitespace-nowrap rounded-[4px] bg-fill px-2 py-1.5 font-mono text-[12px] text-ink">
				$ {step.command}
			</code>
		</li>
	);
}

/** One step of the loop: label, heading and verb-first points beside its working sample; `flip` swaps the sides. */
function Feature({
	feature,
	flip,
	children,
}: {
	feature: FeatureData;
	flip: boolean;
	children: ReactNode;
}): ReactElement {
	return (
		<article className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16">
			<div className={`flex flex-col gap-5 ${flip ? "lg:order-2" : ""}`}>
				<p className="font-mono text-accent-text text-xs">{feature.label}</p>
				<h3 className={`text-balance text-[1.9rem] text-ink leading-[1.02] sm:text-[2.3rem] ${DISPLAY}`}>
					{feature.title}
				</h3>
				<ul className="flex flex-col border-hairline border-t">
					{feature.points.map((point) => (
						<li className="border-hairline border-b py-2.5 text-ink-2 leading-relaxed" key={point}>
							{point}
						</li>
					))}
				</ul>
				<Link
					className="self-start font-mono text-ink text-xs underline decoration-ink-2 underline-offset-4 hover:decoration-accent"
					params={{ _splat: feature.link.to }}
					to="/docs/$"
				>
					{feature.link.text} →
				</Link>
			</div>
			<div className={`min-w-0 ${flip ? "lg:order-1" : ""}`}>{children}</div>
		</article>
	);
}

/** A code or terminal sample on a sheet, its file or tool named in a mono tab; `#` lines read as comments. */
function Terminal({ code, label }: { code: string; label: string }): ReactElement {
	return (
		<figure className="flex flex-col overflow-hidden rounded-[var(--radius-group)] border border-hairline bg-surface">
			<figcaption className="flex items-center gap-2 border-hairline border-b px-4 py-2.5 font-mono text-[11px] text-ink-2">
				<span aria-hidden="true" className="flex gap-1.5">
					<span className="size-2.5 rounded-full bg-fill" />
					<span className="size-2.5 rounded-full bg-fill" />
					<span className="size-2.5 rounded-full bg-fill" />
				</span>
				<span className="ms-2">{label}</span>
			</figcaption>
			<pre className="overflow-x-auto p-5 font-mono text-[12.5px] text-ink leading-relaxed">
				<code>
					{code.split("\n").map((line, i) => (
						<span className={`block ${line.startsWith("#") ? "text-ink-2" : ""}`} key={`${i}-${line}`}>
							{line || " "}
						</span>
					))}
				</code>
			</pre>
		</figure>
	);
}

const BOARD_COLUMNS = "sm:grid sm:grid-cols-[1.1fr_1.3fr_1.1fr_0.6fr_1.1fr] sm:items-center sm:gap-6";

/**
 * Five agents on one Mac and what each one holds: a device, a Metro port and a build. A leased
 * row carries the lamp from the warden mark; the queued row is a hollow ring in Ink 2. Below
 * `sm` each row folds to two lines, agent and worktree over device, port and build.
 */
function LeaseBoard(): ReactElement {
	return (
		<figure className="flex flex-col overflow-hidden rounded-[var(--radius-group)] border border-hairline bg-surface">
			<div
				aria-hidden="true"
				className={`hidden border-hairline border-b px-6 py-2.5 font-mono text-[11px] text-ink-2 ${BOARD_COLUMNS}`}
			>
				<span className="ps-5">agent</span>
				<span>worktree</span>
				<span>device</span>
				<span>metro</span>
				<span>build</span>
			</div>
			<ul className="flex flex-col">
				{BOARD.map((row) => {
					const queued = row.state === "queued";
					return (
						<li
							className={`flex flex-col gap-1.5 border-hairline border-b px-4 py-4 last:border-b-0 sm:px-6 ${BOARD_COLUMNS} ${queued ? "text-ink-2" : "text-ink"}`}
							key={row.agent}
						>
							<span className="flex items-center gap-3 [font-variation-settings:'wdth'_112,'wght'_620]">
								<span
									className={`size-2 shrink-0 rounded-full ${queued ? "border border-ink-2" : "bg-accent"}`}
									title={row.state}
								/>
								{row.agent}
								<span className="sr-only">{queued ? ", queued" : ", leased"}</span>
							</span>
							<span className="ps-5 font-mono text-[12.5px] sm:ps-0">{row.worktree}</span>
							<span className="flex flex-wrap gap-x-3 ps-5 text-ink-2 text-sm sm:contents">
								<span className={queued ? "" : "sm:text-ink"}>{row.device}</span>
								<span className={`font-mono text-[12.5px] tabular-nums ${queued ? "hidden sm:inline" : ""}`}>
									{row.port}
								</span>
								<span className={`font-mono text-[12.5px] tabular-nums ${queued ? "hidden sm:inline" : ""}`}>
									{row.build}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
			<figcaption className="border-hairline border-t px-4 py-3 font-mono text-[11px] text-ink-2 leading-relaxed sm:px-6">
				{BOARD_COPY.caption}
			</figcaption>
		</figure>
	);
}

/** The measured serial and parallel runs as two bars on one time axis; width is proportional to job time. */
function RunChart(): ReactElement {
	const max = RUNS[0].seconds;
	return (
		<figure className="flex flex-col gap-6 rounded-[var(--radius-group)] border border-hairline bg-surface p-6 sm:p-8">
			{RUNS.map((run, i) => (
				<div className="flex flex-col gap-2" key={run.label}>
					<div className="flex items-baseline justify-between">
						<span className="font-mono text-ink-2 text-xs">{run.label}</span>
						<span
							className={`text-[2.1rem] tabular-nums leading-none ${DISPLAY} ${i === 1 ? "text-accent" : "text-ink"}`}
						>
							{run.time}
						</span>
					</div>
					<div className="h-3 w-full rounded-full bg-fill">
						<div
							className={`h-full rounded-full ${i === 1 ? "bg-accent" : "bg-ink"}`}
							style={{ width: `${(run.seconds / max) * 100}%` }}
						/>
					</div>
				</div>
			))}
			<figcaption className="border-hairline border-t pt-3 font-mono text-[11px] text-ink-2 leading-relaxed">
				Salient&apos;s 37 offline e2e specs on iPhone 17 simulators, job time after Metro is ready. Oct 2026.
			</figcaption>
		</figure>
	);
}

/** Claim cards in a grid; `columns` sets the breakpoints above one column. */
function CardGrid({ cards, columns }: { cards: readonly Claim[]; columns: string }): ReactElement {
	return (
		<div className={`grid grid-cols-1 gap-4 ${columns}`}>
			{cards.map((card) => (
				<Card card={card} key={card.title} />
			))}
		</div>
	);
}

/**
 * A flat sheet: the command it names as a chip, a heading in a slightly narrower cut of the display voice, one or two
 * sentences, and the docs page that says more.
 */
function Card({ card }: { card: Claim }): ReactElement {
	return (
		<div className="flex flex-col gap-3 rounded-[var(--radius-group)] border border-hairline bg-surface p-6 text-start">
			<span className="self-start rounded-[4px] bg-fill px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
				{card.command}
			</span>
			<h3 className="text-ink text-xl leading-tight tracking-[-0.02em] [font-variation-settings:'wdth'_120,'wght'_720]">
				{card.title}
			</h3>
			<p className="flex-1 text-ink-2 leading-relaxed">
				<RichText text={card.body} />
			</p>
			<Link
				aria-label={`Read more: ${card.title}`}
				className="self-start pt-2 font-mono text-[11px] text-ink uppercase tracking-[0.12em] hover:text-accent-text"
				params={{ _splat: card.href }}
				to="/docs/$"
			>
				Read more →
			</Link>
		</div>
	);
}

function Faq({ q, children }: { q: string; children: ReactNode }): ReactElement {
	return (
		<details className="group border-hairline border-b">
			<summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-ink text-lg [font-variation-settings:'wdth'_112,'wght'_600] hover:text-accent-text">
				{q}
				<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
					<path d="M2 8h12" stroke="currentColor" strokeWidth="1.5" />
					<path className="faq-plus-v" d="M8 2v12" stroke="currentColor" strokeWidth="1.5" />
				</svg>
			</summary>
			<p className="max-w-[68ch] pb-6 text-ink-2 leading-relaxed">{children}</p>
		</details>
	);
}

function AgentLink({ href, note, children }: { href: string; note: string; children: ReactNode }): ReactElement {
	return (
		<a
			className="flex flex-col gap-1 rounded-[var(--radius-group)] border border-hairline bg-surface p-4 transition-colors hover:border-ink"
			href={href}
		>
			<span className="font-mono text-ink text-xs">{children}</span>
			<span className="text-ink-2 text-sm">{note}</span>
		</a>
	);
}

const BUTTON = "inline-flex items-center rounded-full px-5 py-2.5 text-sm transition-colors";

function PrimaryLink({ to, children }: { to: string; children: ReactNode }): ReactElement {
	return (
		<Link
			className={`${BUTTON} bg-ink text-ground [font-variation-settings:'wdth'_110,'wght'_600] hover:bg-accent hover:text-ink`}
			params={{ _splat: to }}
			to="/docs/$"
		>
			{children}
		</Link>
	);
}

function SecondaryLink({ to, children }: { to: string; children: ReactNode }): ReactElement {
	return (
		<Link
			className={`${BUTTON} border border-hairline text-ink [font-variation-settings:'wdth'_110,'wght'_520] hover:border-ink`}
			params={{ _splat: to }}
			to="/docs/$"
		>
			{children}
		</Link>
	);
}

function SecondaryAnchor({ href, children }: { href: string; children: ReactNode }): ReactElement {
	return (
		<a
			className={`${BUTTON} border border-hairline text-ink [font-variation-settings:'wdth'_110,'wght'_520] hover:border-ink`}
			href={href}
		>
			{children}
		</a>
	);
}
