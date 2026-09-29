import { Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { WardenIcon } from "@/components/warden-icon";
import { baseOptions } from "@/lib/layout.shared";

export function NotFound(): ReactElement {
	return (
		<HomeLayout {...baseOptions()}>
			<main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-start justify-center gap-6 px-4 py-24">
				<WardenIcon size={40} />
				<p className="font-mono text-fd-muted-foreground text-sm">404</p>
				<h1 className="font-semibold text-4xl">There is no page here.</h1>
				<p className="text-fd-muted-foreground text-lg">The address may have changed, or it was never one of ours.</p>
				<div className="flex gap-3">
					<Link
						className="rounded-full bg-fd-primary px-5 py-2 font-medium text-fd-primary-foreground text-sm"
						to="/docs/$"
					>
						Read the docs
					</Link>
					<Link className="rounded-full border border-fd-border px-5 py-2 font-medium text-sm" to="/">
						Home
					</Link>
				</div>
			</main>
		</HomeLayout>
	);
}
