import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { COLUMN, DISPLAY, LegalSectionBlock } from "@/components/legal-sections";
import { RichText } from "@/components/rich-text";
import { baseOptions } from "@/lib/layout.shared";
import { canonicalLink } from "@/lib/seo";
import { appName, termsRoute } from "@/lib/shared";
import { TERMS, TERMS_SECTIONS } from "@/lib/terms";

/**
 * `/terms`: warden cloud's terms of service. Every word is read from
 * `src/lib/terms.ts`. The date is formatted in UTC so the server and the
 * browser print the same day.
 */
export const Route = createFileRoute("/terms")({
	component: Terms,
	head: () => ({
		meta: [
			{ title: `${TERMS.title} — ${appName}` },
			{ name: "description", content: TERMS.description },
			{ property: "og:title", content: `${TERMS.title} — ${appName}` },
			{ property: "og:description", content: TERMS.description },
			{ property: "og:url", content: canonicalLink(termsRoute).href },
		],
		links: [canonicalLink(termsRoute)],
	}),
});

const UPDATED = new Date(`${TERMS.updated}T00:00:00Z`).toLocaleDateString("en-NZ", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

function Terms(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className={`${COLUMN} flex flex-1 flex-col gap-14 pt-16 pb-24 sm:pt-24`}>
				<header className="flex flex-col gap-4">
					<p className="font-mono text-[11px] text-ink-2">
						Last updated <time dateTime={TERMS.updated}>{UPDATED}</time>
					</p>
					<h1 className={`text-[clamp(2.2rem,5vw,3.6rem)] text-ink leading-[0.98] ${DISPLAY}`}>{TERMS.title}</h1>
					<p className="text-ink-2 text-lg leading-relaxed">
						<RichText text={TERMS.lede} />
					</p>
				</header>
				{TERMS_SECTIONS.map((section) => (
					<LegalSectionBlock key={section.id} section={section} />
				))}
			</main>
		</HomeLayout>
	);
}
