import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Activity, Ban, Cable, HeartPulse, LogOut, Plug, Recycle, Terminal } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { CopyCommand } from "@/components/copy-command";
import { GroupedList, GroupedRow } from "@/components/grouped-list";
import { BootChart } from "@/components/landing/boot-chart";
import { DeviceShelf } from "@/components/landing/device-shelf";
import { WardenIcon } from "@/components/warden-icon";
import { baseOptions } from "@/lib/layout.shared";
import { appDescription, appName, githubUrl } from "@/lib/shared";

export const Route = createFileRoute("/")({
	component: Home,
	head: () => ({
		meta: [{ title: `${appName} — one simulator per agent` }, { name: "description", content: appDescription }],
	}),
});

const PAGE = "mx-auto w-full max-w-6xl px-4 sm:px-6";

function Section({ title, lede, children }: { title: string; lede: ReactNode; children: ReactNode }): ReactElement {
	return (
		<section className={`${PAGE} flex flex-col gap-8 pt-28 sm:pt-36`}>
			<div className="flex max-w-2xl flex-col gap-3">
				<h2 className="font-semibold text-3xl text-ink sm:text-4xl">{title}</h2>
				<p className="text-ink-2 text-lg">{lede}</p>
			</div>
			{children}
		</section>
	);
}

/**
 * The landing page is warden's own device shelf. The first viewport states the
 * two promises — isolation and speed — and demonstrates both on the shelf;
 * the page then proves speed on a measured time axis, lays out the lease
 * rules as a grouped list, shows the agent hooks, and closes on install.
 */
function Home(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className="flex flex-1 flex-col pb-28">
				<section className={`${PAGE} flex flex-col gap-8 pt-10 sm:pt-12`}>
					<div className="flex flex-col gap-8">
						<h1 className="font-semibold text-[2.6rem] text-ink-2 leading-[1.02] tracking-[-0.035em] sm:text-6xl lg:text-[4rem]">
							One simulator per agent.
							<br />
							<span className="text-ink">Booted in 16 seconds.</span>
						</h1>
						<div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
							<p className="max-w-2xl text-ink text-lg leading-relaxed">
								warden leases every simulator, emulator and port on your Mac to exactly one agent, worktree or human,
								and clones new sims from a golden image instead of cold-booting them.
							</p>
							<div className="flex shrink-0 flex-wrap gap-3">
								<Link
									className="rounded-full bg-ink px-5 py-2.5 font-medium text-sm text-surface transition-opacity hover:opacity-85"
									params={{ _splat: "installation" }}
									to="/docs/$"
								>
									Install warden
								</Link>
								<Link
									className="rounded-full bg-surface px-5 py-2.5 font-medium text-ink text-sm transition-colors hover:bg-fill"
									params={{ _splat: "concepts" }}
									to="/docs/$"
								>
									How leases work
								</Link>
							</div>
						</div>
					</div>
					<DeviceShelf />
				</section>

				<Section
					lede="A new simulator's first boot spends most of its time on a one-time data migration. warden does that once, keeps the result as a golden image, and clones every new pool device from it."
					title="Sixteen seconds, not four minutes."
				>
					<BootChart />
				</Section>

				<Section
					lede="Every claim runs in one sqlite transaction on this machine, so two agents asking at the same instant are served in turn, never both."
					title="One lease per device."
				>
					<div className="grid grid-cols-1 gap-6 *:min-w-0 lg:grid-cols-2">
						<GroupedList label="Lease rules">
							<GroupedRow
								detail="Reuse a free booted warden sim, else clone one, up to --max per profile."
								leading={<Activity className="size-[18px]" />}
								title="Claim"
								trailing={<Tag>claim</Tag>}
							/>
							<GroupedRow
								detail="A lease lives while its pid lives or its heartbeat is under 30 min old."
								leading={<HeartPulse className="size-[18px]" />}
								title="Stay alive"
								trailing={<Tag>heartbeat</Tag>}
							/>
							<GroupedRow
								detail="Only sims warden created, or you booted, are shut down on release."
								leading={<LogOut className="size-[18px]" />}
								title="Release"
								trailing={<Tag>release</Tag>}
							/>
							<GroupedRow
								detail="Dead sessions' leases go stale and their sims are shut down. Never deleted."
								leading={<Recycle className="size-[18px]" />}
								title="Reclaim"
								trailing={<Tag>gc</Tag>}
							/>
						</GroupedList>
						<GroupedList label="What warden will not do">
							<GroupedRow
								detail="Your own Simulator.app or another tool's sim is read-only unless you pass --adopt."
								leading={<Ban className="size-[18px]" />}
								title="Touch a device it didn't create"
							/>
							<GroupedRow
								detail="warden check exits 2 when another owner holds a device."
								leading={<Ban className="size-[18px]" />}
								title="Hand one device to two owners"
							/>
							<GroupedRow
								detail="Ports are bind-probed and leased from a range, like devices."
								leading={<Ban className="size-[18px]" />}
								title="Give out a port that's in use"
							/>
							<GroupedRow
								detail="Goldens are never allocated, booted by gc, or counted in the pool."
								leading={<Ban className="size-[18px]" />}
								title="Boot a golden image"
							/>
						</GroupedList>
					</div>
				</Section>

				<Section
					lede="warden install adds two hooks to Claude Code and Codex. An agent's first argent call claims a device for its session; a call on someone else's device is blocked."
					title="Your agents claim before they tap."
				>
					<div className="grid grid-cols-1 gap-6 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
						<GroupedList label="Agent hooks">
							<GroupedRow
								detail="Auto-claims an unleased device, heartbeats your own, blocks another owner's with their repo and worktree."
								leading={<Plug className="size-[18px]" />}
								title="PreToolUse"
							/>
							<GroupedRow
								detail="Shuts down the sims the session booted and releases its leases. /clear keeps them running."
								leading={<Cable className="size-[18px]" />}
								title="SessionEnd"
							/>
							<GroupedRow
								detail="Claims devices and ports, exports them to your script, releases on exit."
								leading={<Terminal className="size-[18px]" />}
								title="warden run"
							/>
						</GroupedList>
						<div className="flex flex-col gap-3">
							<pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-group)] bg-surface p-5 sm:whitespace-pre font-mono text-ink text-sm leading-relaxed">
								<span className="text-ink-2">$ </span>warden run ios --count 2 --port 8091:20 -- bun run e2e
								{"\n\n"}
								<span className="text-ink-2">
									WARDEN_UDIDS=8F3A2C1E-…,41D09B7A-…{"\n"}WARDEN_PORT_0=8093{"\n"}# heartbeat every 30 s · SIGINT
									forwarded · released on exit
								</span>
							</pre>
							<p className="text-ink-2 text-sm">
								Codex skips new hooks until you trust them: run <code className="font-mono text-ink">/hooks</code> once
								after installing.
							</p>
						</div>
					</div>
				</Section>

				<Section
					lede="Build from a checkout, wire the hooks, check the setup. Every agent-config change shows a diff and asks first."
					title="Install"
				>
					<ol className="grid grid-cols-1 gap-4 *:min-w-0 lg:grid-cols-[1.5fr_1fr_1fr]">
						<InstallStep command="bun run --cwd apps/cli install:global" n={1} title="Build the binary" />
						<InstallStep command="warden install" n={2} title="Hook up your agents" />
						<InstallStep command="warden doctor" n={3} title="Check it" />
					</ol>
					<Link
						className="self-start rounded-full bg-ink px-5 py-2.5 font-medium text-sm text-surface transition-opacity hover:opacity-85"
						params={{ _splat: "installation" }}
						to="/docs/$"
					>
						Read the install guide
					</Link>
				</Section>
			</main>
			<footer className="border-hairline border-t">
				<div className={`${PAGE} flex flex-wrap items-center gap-x-6 gap-y-2 py-8 text-ink-2 text-sm`}>
					<span className="inline-flex items-center gap-2 font-medium text-ink">
						<WardenIcon size={18} />
						warden
					</span>
					<Link className="hover:text-ink" params={{ _splat: "reference/cli" }} to="/docs/$">
						CLI reference
					</Link>
					<a className="hover:text-ink" href="/llms.txt">
						llms.txt
					</a>
					<a className="hover:text-ink" href={githubUrl} rel="noreferrer noopener" target="_blank">
						GitHub
					</a>
					<span className="sm:ms-auto">Built by Delacour</span>
				</div>
			</footer>
		</HomeLayout>
	);
}

function Tag({ children }: { children: ReactNode }): ReactElement {
	return <span className="rounded-md bg-ground px-2 py-0.5 font-mono text-ink-2 text-xs">{children}</span>;
}

function InstallStep({ n, title, command }: { n: number; title: string; command: string }): ReactElement {
	return (
		<li className="flex flex-col gap-3 rounded-[var(--radius-group)] bg-surface p-4">
			<p className="flex items-baseline gap-2 font-medium text-ink">
				<span className="font-mono text-ink-2 text-sm tabular-nums">{n}</span>
				{title}
			</p>
			<CopyCommand command={command} />
		</li>
	);
}
