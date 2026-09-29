import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Boxes, Cable, HardDriveDownload, Layers, ShieldCheck, Timer } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { WardenIcon } from "@/components/warden-icon";
import { baseOptions } from "@/lib/layout.shared";
import { appDescription, appName } from "@/lib/shared";

export const Route = createFileRoute("/")({
	component: Home,
	head: () => ({
		meta: [{ title: `${appName} — device leasing for agents` }, { name: "description", content: appDescription }],
	}),
});

type Feature = { icon: ReactNode; title: string; body: string };

const FEATURES: readonly Feature[] = [
	{
		icon: <ShieldCheck />,
		title: "Exclusive leases",
		body: "One sqlite db, claims under BEGIN IMMEDIATE. A device or port leased by one owner is never handed to another.",
	},
	{
		icon: <Cable />,
		title: "Agent hooks",
		body: "Claude Code and Codex hooks auto-claim argent devices per session and block calls on someone else's.",
	},
	{
		icon: <Layers />,
		title: "Golden images",
		body: "New simulators are cloned from a settled golden: ~16 s to a booted sim instead of 2–4 min.",
	},
	{
		icon: <Timer />,
		title: "Liveness + gc",
		body: "Leases live while their pid or heartbeat does. Dead sessions are reclaimed and their sims shut down.",
	},
	{
		icon: <HardDriveDownload />,
		title: "Build reuse",
		body: "Expo fingerprint → installed → cache → EAS → local build. Every worktree of a repo shares one cache.",
	},
	{
		icon: <Boxes />,
		title: "e2e in one line",
		body: "warden run claims N devices and ports, exports them to your script and releases everything on exit.",
	},
];

const INSTALL = `bun install
bun run --cwd apps/cli install:global
warden install
warden claim ios --json`;

/** The landing page: a single column — mark, headline, CTAs, the install card, then the feature grid. */
function Home(): ReactElement {
	return (
		<HomeLayout {...baseOptions()}>
			<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-20 px-4 py-20">
				<section className="flex max-w-2xl flex-col items-start gap-6">
					<WardenIcon size={48} />
					<h1 className="font-semibold text-4xl tracking-tight sm:text-5xl">
						Simulators, emulators and ports that nobody else is driving.
					</h1>
					<p className="text-fd-muted-foreground text-lg">{appDescription}</p>
					<div className="flex flex-wrap gap-3">
						<Link
							className="rounded-full bg-fd-primary px-5 py-2 font-medium text-fd-primary-foreground text-sm"
							params={{ _splat: "installation" }}
							to="/docs/$"
						>
							Get started
						</Link>
						<Link
							className="rounded-full border border-fd-border px-5 py-2 font-medium text-sm"
							params={{ _splat: "reference/cli" }}
							to="/docs/$"
						>
							CLI reference
						</Link>
					</div>
					<pre className="w-full overflow-x-auto rounded-xl border border-fd-border bg-fd-card p-4 font-mono text-sm">
						{INSTALL}
					</pre>
				</section>
				<section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{FEATURES.map((feature) => (
						<div className="flex flex-col gap-2 rounded-xl border border-fd-border bg-fd-card p-5" key={feature.title}>
							<span className="text-fd-primary [&_svg]:size-5">{feature.icon}</span>
							<h2 className="font-semibold">{feature.title}</h2>
							<p className="text-fd-muted-foreground text-sm">{feature.body}</p>
						</div>
					))}
				</section>
			</main>
		</HomeLayout>
	);
}
