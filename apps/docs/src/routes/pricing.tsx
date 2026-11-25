import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { COLUMN, DISPLAY, LegalSectionBlock } from "@/components/legal-sections";
import { RichText } from "@/components/rich-text";
import { baseOptions } from "@/lib/layout.shared";
import { PRICING, PRICING_SECTIONS } from "@/lib/pricing";
import { canonicalLink } from "@/lib/seo";
import { appName, pricingRoute } from "@/lib/shared";

/**
 * `/pricing`: what warden cloud costs. Every word is read from
 * `src/lib/pricing.ts`; nothing is written in this file.
 */
export const Route = createFileRoute("/pricing")({
	component: Pricing,
	head: () => ({
		meta: [
			{ title: `${PRICING.title} — ${appName}` },
			{ name: "description", content: PRICING.description },
			{ property: "og:title", content: `${PRICING.title} — ${appName}` },
			{ property: "og:description", content: PRICING.description },
			{ property: "og:url", content: canonicalLink(pricingRoute).href },
		],
		links: [canonicalLink(pricingRoute)],
	}),
});

function Pricing(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className={`${COLUMN} flex flex-1 flex-col gap-14 pt-16 pb-24 sm:pt-24`}>
				<header className="flex flex-col gap-4">
					<h1 className={`text-[clamp(2.2rem,5vw,3.6rem)] text-ink leading-[0.98] ${DISPLAY}`}>{PRICING.title}</h1>
					<p className="text-ink-2 text-lg leading-relaxed">
						<RichText text={PRICING.lede} />
					</p>
				</header>
				{PRICING_SECTIONS.map((section) => (
					<LegalSectionBlock key={section.id} section={section} />
				))}
			</main>
		</HomeLayout>
	);
}
