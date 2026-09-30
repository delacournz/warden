import { Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { DeviceFrame } from "@/components/device";
import { baseOptions } from "@/lib/layout.shared";

/** The missing page as a device slot warden never created: dashed outline, no lease, and two ways on. */
export function NotFound(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-start gap-10 px-4 py-20 sm:flex-row sm:items-center sm:gap-16 sm:px-6">
				<div className="relative w-28 shrink-0 sm:w-40">
					<DeviceFrame className="h-auto w-full" phase="empty" />
					<p className="absolute inset-0 flex flex-col items-center justify-center gap-1 font-mono text-ink-2">
						<span className="font-medium text-3xl text-ink tabular-nums sm:text-4xl">404</span>
						<span className="text-xs">not created</span>
					</p>
				</div>
				<div className="flex flex-col gap-5">
					<h1 className="font-semibold text-4xl text-ink sm:text-5xl">No page at this address.</h1>
					<p className="max-w-md text-ink-2 text-lg">
						It may have moved, or it never existed. The docs and the CLI reference are where most links mean to go.
					</p>
					<div className="flex flex-wrap gap-3">
						<Link
							className="rounded-full bg-ink px-5 py-2.5 font-medium text-sm text-surface transition-opacity hover:opacity-85"
							to="/docs/$"
						>
							Read the docs
						</Link>
						<Link
							className="rounded-full bg-surface px-5 py-2.5 font-medium text-ink text-sm transition-colors hover:bg-fill"
							params={{ _splat: "reference/cli" }}
							to="/docs/$"
						>
							CLI reference
						</Link>
					</div>
				</div>
			</main>
		</HomeLayout>
	);
}
