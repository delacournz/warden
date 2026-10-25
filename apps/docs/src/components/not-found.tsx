import { Link, useLocation } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { baseOptions } from "@/lib/layout.shared";

/**
 * The missing page in the display voice: a giant 404 in the heaviest, widest
 * setting with the accent on the final glyph, a mono readout under a hairline
 * naming the path that missed, then one headline, one lede and the pill pair.
 */
export function NotFound(): ReactElement {
	const { pathname } = useLocation();
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-8 px-4 py-16 sm:px-6 sm:py-24">
				<p
					aria-hidden="true"
					className="text-[clamp(7rem,32vw,20rem)] text-ink leading-[0.85] tracking-[-0.04em] [font-variation-settings:'wdth'_125,'wght'_880]"
				>
					40<span className="text-accent">4</span>
				</p>
				<p className="break-all border-hairline border-t pt-3 font-mono text-[11px] text-ink-2">
					warden: no page at <span className="text-ink">{pathname}</span>
				</p>
				<div className="flex flex-col gap-4">
					<h1 className="text-balance text-[1.9rem] text-ink leading-[1.02] tracking-[-0.035em] [font-variation-settings:'wdth'_125,'wght'_800] sm:text-[2.4rem]">
						No page at this address.
					</h1>
					<p className="max-w-[60ch] text-ink-2 text-lg leading-relaxed">
						It may have moved, or it never existed. The docs are where most links mean to go.
					</p>
					<div className="flex flex-wrap gap-3">
						<Link
							className="rounded-full bg-ink px-5 py-2.5 font-medium text-sm text-surface transition-opacity hover:opacity-85"
							to="/docs/$"
						>
							Go to docs
						</Link>
						<Link
							className="rounded-full bg-surface px-5 py-2.5 font-medium text-ink text-sm transition-colors hover:bg-fill"
							to="/"
						>
							Home
						</Link>
					</div>
				</div>
			</main>
		</HomeLayout>
	);
}
