import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement, ReactNode } from "react";
import { CopyBlock } from "@/components/copy-block";
import { InstallCommand } from "@/components/install-command";
import { DemoVideo } from "@/components/landing/demo-video";
import { WardenIcon } from "@/components/warden-icon";
import { ANALYTICS } from "@/lib/analytics/config";
import { CONSENT_OPEN_EVENT } from "@/lib/analytics/consent";
import { baseOptions } from "@/lib/layout.shared";
import { appDescription, appName, githubUrl, privacyRoute } from "@/lib/shared";

export const Route = createFileRoute("/")({
	component: Home,
	head: () => ({
		meta: [
			{ title: `${appName} — open-source mobile testing for coding agents` },
			{ name: "description", content: appDescription },
		],
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

const DRIVE_SAMPLE = `# your agent, on its own simulator
$ warden claim ios --json
$ warden ui open com.example.app
$ warden ui snapshot -i
@e1 [textbox] "Add a todo" id=todo-input value="" enabled hittable
@e2 [button] "Add" id=todo-add enabled hittable
$ warden ui fill @e1 "Write e2e specs"
$ warden ui press @e2 --settle
$ warden ui wait text="Write e2e specs"`;

const KEEP_SAMPLE = `import { expect, test } from "@delacour/warden-e2e";

test("add a todo", async ({ screen }) => {
  await screen.getByTestId("todo-input").fill("Write e2e specs");
  await screen.getByTestId("todo-add").tap();
  await expect(screen.getByText("Write e2e specs")).toBeVisible();
  await expect(screen.getByTestId("remaining")).toHaveText("2 left");
});`;

const AGENT_PROMPT = `Install warden (npm i -g @delacour/warden && warden install) and set this Expo app up with warden init.
Claim an iOS simulator, open the app with warden ui and check the home screen renders.
Save what you checked as an e2e spec under e2e/, run it with warden e2e, and release the simulator when you're done.`;

/** Measured on Salient's 37 offline specs, iPhone 17 simulators, Oct 2026: job phase after the serve step is ready. */
const RUNS = [
	{ label: "1 simulator", time: "13m55s", seconds: 835 },
	{ label: "5 simulators", time: "3m25s", seconds: 205 },
] as const;

/**
 * The landing in the familiar agent dev-tool frame: a centered hero with one
 * install command and the recorded run, a centered "Works with" row of agent
 * marks, then the loop as three alternating feature blocks (copy beside a
 * working sample), the lease rules, the first-prompt block, use-case cards,
 * the FAQ and a closing call to action that repeats the install. Every
 * heading uses the one display voice, Mona Sans wide and heavy.
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
						open source · MIT · iOS + Android
					</a>
					<h1 className={`max-w-5xl text-balance text-[clamp(2.6rem,6.4vw,5.4rem)] text-ink leading-[0.95] ${DISPLAY}`}>
						Mobile testing for <span className="text-accent">coding agents.</span>
					</h1>
					<p className="max-w-2xl text-balance text-ink-2 text-lg leading-relaxed sm:text-xl">
						warden gives your agent its own iOS simulator or Android emulator. It drives your app, keeps what it
						verified as an e2e test, and runs the whole suite across every simulator on your Mac.
					</p>
					<div className="flex w-full max-w-xl flex-col items-center gap-3">
						<InstallCommand className="w-full items-center text-start" setup />
						<p className="text-ink-2 text-sm">Installs the CLI and the skill for every agent it finds.</p>
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

				<Section
					lede="Your agent runs your iOS or Android app, sees what happened, and keeps going in the same session. Then it keeps what it checked, and the suite runs everywhere at once."
					title="Let your agent take it from here."
				>
					<div className="flex flex-col gap-20 sm:gap-28">
						<Feature
							label="Drive it"
							link={{ to: "agents/ui", text: "Drive a device" }}
							points={[
								"Claims a simulator or emulator no one else holds",
								"Reads the screen as @e refs: role, name, testID, state",
								"Presses, fills, scrolls, waits and checks",
								"Every call checks the lease and heartbeats it",
							]}
							title="Simulator control for agents"
						>
							<Terminal code={DRIVE_SAMPLE} label="terminal" />
						</Feature>
						<Feature
							flip
							label="Keep it"
							link={{ to: "e2e/first-test", text: "Write your first test" }}
							points={[
								"The testIDs warden ui found become the spec's locators",
								"Specs are TypeScript on bun test with nine matchers",
								"warden ui and specs share one driver, so a check that passed by hand passes in the spec",
								"The warden skill tells the agent when a check belongs in a spec",
							]}
							title="What it verified becomes a test"
						>
							<Terminal code={KEEP_SAMPLE} label="e2e/add-todo.e2e.ts" />
						</Feature>
						<Feature
							label="Run it"
							link={{ to: "e2e", text: "How e2e works" }}
							points={[
								"warden e2e leases N simulators and installs the build",
								"Starts Metro on its own port, one bun test per device",
								"warden affected runs only the specs a diff reaches",
								"Failures leave a screenshot, the screen tree and a trace",
							]}
							title="The suite on every simulator at once"
						>
							<RunChart />
						</Feature>
					</div>
				</Section>

				<Section
					lede="Every agent, worktree, CI job and shell on your Mac claims from one lease registry. Two agents asking at the same instant are served in turn, never both."
					title="Parallel, never shared."
				>
					<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
						<Card command="BEGIN IMMEDIATE" title="One registry">
							Leases live in one sqlite db at <Code>~/.warden/warden.db</Code>. Every claim is a transaction, so there
							are no lockfiles to go stale.
						</Card>
						<Card command="--adopt" title="Your simulator stays yours">
							A device warden didn't create or lease is read-only: never handed to an agent, shut down, erased or
							installed on.
						</Card>
						<Card command="SessionEnd" title="Cleans up after itself">
							When a session ends, the hook shuts down the simulators it booted and releases its leases.
						</Card>
						<Card command="warden golden" title="New simulators in seconds">
							Pool devices clone from a settled golden image: 3.7 s clone plus 11.9 s boot, instead of 146–239 s.
						</Card>
						<Card command="warden capacity" title="Boots wait their turn">
							Claims queue by host RAM, CPU and priority, so ten agents don't boot ten simulators at once.
						</Card>
						<Card command="warden dev" title="A Metro port per worktree">
							Each worktree gets its own simulator and Metro port, and never attaches to another checkout's Metro.
						</Card>
					</div>
				</Section>

				<Section
					lede="Paste this into Claude Code, Codex, Cursor or any agent in your app's directory. The warden skill tells it the rest."
					title="Productive from the first prompt."
				>
					<div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 text-start">
						<CopyBlock label="prompt" text={AGENT_PROMPT} />
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

				<Section
					lede="The jobs agents get asked to do on a mobile app, and the warden command behind each."
					title="What agents build with it."
				>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<Card command="warden ui wait" title="Verify a UI change">
							The agent changes a screen, opens it on its own simulator and checks it before it says done.
						</Card>
						<Card command="warden ui snapshot" title="Reproduce a bug">
							Walk the steps from the issue on a clean device, then keep the repro as a failing spec.
						</Card>
						<Card command="warden affected" title="Gate every pull request">
							Only the specs a diff reaches run, in CI or a pre-push hook, across leased simulators.
						</Card>
						<Card command="warden dev" title="Parallel worktrees">
							Five agents, five worktrees, five simulators and five Metro ports, side by side on one Mac.
						</Card>
					</div>
				</Section>

				<Section lede="Short answers. The docs have the long ones." title="Questions.">
					<div className="faq mx-auto flex w-full max-w-3xl flex-col border-hairline border-t text-start">
						<Faq q="What is warden?">
							An open-source CLI and e2e framework. It lets coding agents drive iOS simulators and Android emulators,
							save what they verify as tests, and run suites in parallel, with every device leased to one owner at a
							time.
						</Faq>
						<Faq q="How do I install it?">
							<Code>npm i -g @delacour/warden && warden install</Code>. The second command wires the skill and hooks for
							the agents it finds, showing a diff and asking first.
						</Faq>
						<Faq q="Does it work on Android?">
							Yes. warden leases Android emulators (launched <Code>-read-only</Code>), and <Code>warden ui</Code> and
							specs drive them. iOS needs macOS with Xcode.
						</Faq>
						<Faq q="Which agents does it support?">
							Any agent the skills CLI installs into gets the warden skill: Claude Code, Codex, Cursor, GitHub Copilot,
							Gemini CLI, OpenCode, Windsurf, Zed and more. Claude Code and Codex also get the SessionEnd cleanup hook.
						</Faq>
						<Faq q="What does my app need?">
							Build, dev-client and Metro handling target Expo and React Native. <Code>warden ui</Code> and specs drive
							any installed app by bundle id; elements are found by testID, label, text or role.
						</Faq>
						<Faq q="Will it touch my own Simulator.app?">
							No. A booted device warden didn't create or lease is read-only. It is never handed to an agent unless you
							pass <Code>--adopt</Code>.
						</Faq>
						<Faq q="How much does it cost?">
							Nothing. warden is MIT-licensed and runs on your own Mac or CI runner. No account, no cloud.
						</Faq>
					</div>
				</Section>

				<section className={`${PAGE} pt-28 sm:pt-36`}>
					<div className="flex flex-col items-center gap-8 rounded-[var(--radius-group)] border border-hairline bg-surface px-6 py-16 text-center sm:py-20">
						<h2 className={`max-w-3xl text-balance text-[clamp(2.2rem,5vw,4rem)] text-ink leading-[0.95] ${DISPLAY}`}>
							Give your agent a simulator of its own.
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

/** A centered section: display heading, one plain sentence under it, then the content. */
function Section({ title, lede, children }: { title: string; lede: ReactNode; children: ReactNode }): ReactElement {
	return (
		<section className={`${PAGE} flex flex-col gap-12 pt-28 sm:pt-36`}>
			<div className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
				<h2 className={`text-balance text-[clamp(2.2rem,4.6vw,3.6rem)] text-ink leading-[0.98] ${DISPLAY}`}>{title}</h2>
				<p className="max-w-2xl text-balance text-ink-2 text-lg leading-relaxed">{lede}</p>
			</div>
			{children}
		</section>
	);
}

/** One step of the loop: label, heading and verb-first points beside its working sample; `flip` swaps the sides. */
function Feature({
	label,
	title,
	points,
	link,
	flip = false,
	children,
}: {
	label: string;
	title: string;
	points: readonly string[];
	link: { to: string; text: string };
	flip?: boolean;
	children: ReactNode;
}): ReactElement {
	return (
		<article className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16">
			<div className={`flex flex-col gap-5 ${flip ? "lg:order-2" : ""}`}>
				<p className="font-mono text-accent-text text-xs">{label}</p>
				<h3 className={`text-balance text-[1.9rem] text-ink leading-[1.02] sm:text-[2.3rem] ${DISPLAY}`}>{title}</h3>
				<ul className="flex flex-col border-hairline border-t">
					{points.map((point) => (
						<li className="border-hairline border-b py-2.5 text-ink-2 leading-relaxed" key={point}>
							{point}
						</li>
					))}
				</ul>
				<Link
					className="self-start font-mono text-ink text-xs underline decoration-ink-2 underline-offset-4 hover:decoration-accent"
					params={{ _splat: link.to }}
					to="/docs/$"
				>
					{link.text} →
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

/** A flat sheet: a heading in a slightly narrower cut of the display voice, one sentence, and the command it names. */
function Card({ title, command, children }: { title: string; command: string; children: ReactNode }): ReactElement {
	return (
		<div className="flex flex-col gap-3 rounded-[var(--radius-group)] border border-hairline bg-surface p-6 text-start">
			<span className="self-start rounded-[4px] bg-fill px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{command}</span>
			<h3 className="text-ink text-xl leading-tight tracking-[-0.02em] [font-variation-settings:'wdth'_120,'wght'_720]">
				{title}
			</h3>
			<p className="text-ink-2 leading-relaxed">{children}</p>
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

function Code({ children }: { children: ReactNode }): ReactElement {
	return <code className="rounded-[4px] bg-fill px-1 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>;
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
