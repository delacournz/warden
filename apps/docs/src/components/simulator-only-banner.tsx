import { TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { simulatorOnlyNotice } from "@/lib/simulator-only";

/**
 * The orange bar between a docs page's description and its toolbar on a `simulatorOnly` page: the feature runs
 * on simulators and emulators only. A full-width bar is a large mark, so it may carry the accent (One Orange
 * Rule); its text is ink, which reads on the accent in both themes.
 */
export function SimulatorOnlyBanner({ subject }: { subject: string }): ReactElement {
	return (
		<div
			className="mb-4 flex items-start gap-2.5 rounded-group bg-accent px-4 py-3 font-medium text-accent-ink text-sm"
			role="note"
		>
			<TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
			<p>{simulatorOnlyNotice(subject)}</p>
		</div>
	);
}
