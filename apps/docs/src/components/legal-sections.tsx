import type { ReactElement } from "react";
import { RichText } from "@/components/rich-text";

export const COLUMN = "mx-auto w-full max-w-3xl px-4 sm:px-6";
export const DISPLAY = "tracking-[-0.035em] [font-variation-settings:'wdth'_125,'wght'_800]";
export const HEADING =
	"scroll-mt-24 text-[1.4rem] text-ink leading-tight tracking-[-0.02em] [font-variation-settings:'wdth'_120,'wght'_720]";

type LegalSection = { id: string; title: string; body: readonly string[] };

/** One titled run of prose, shared by the pricing and terms pages. */
export function LegalSectionBlock({ section }: { section: LegalSection }): ReactElement {
	return (
		<section aria-labelledby={section.id} className="flex flex-col gap-4">
			<h2 className={HEADING} id={section.id}>
				{section.title}
			</h2>
			<div className="flex flex-col gap-4">
				{section.body.map((paragraph) => (
					<p className="text-ink-2 leading-relaxed" key={paragraph}>
						<RichText text={paragraph} />
					</p>
				))}
			</div>
		</section>
	);
}
