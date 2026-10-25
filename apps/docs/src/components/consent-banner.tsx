import { Link } from "@tanstack/react-router";
import { type ReactElement, useEffect, useState } from "react";
import { ANALYTICS } from "@/lib/analytics/config";
import { CONSENT_OPEN_EVENT, type Consent, readConsent, writeConsent } from "@/lib/analytics/consent";
import { privacyRoute } from "@/lib/shared";

const BUTTON = "inline-flex h-9 flex-1 items-center justify-center rounded-full px-4 text-sm transition-colors";

/**
 * Asks once whether PostHog may set its cookie and record the session.
 *
 * It renders nothing on the server and nothing until mounted, because the
 * answer lives in `localStorage` and a server-rendered banner would flash at
 * every visitor who has already chosen. It renders nothing at all on a build
 * without PostHog, since there is then nothing to consent to.
 *
 * The two buttons are equal weight, and Decline is not hidden behind a
 * settings page: consent that is easier to give than to refuse is not consent
 * under the GDPR. The footer's "Cookie settings" fires `CONSENT_OPEN_EVENT` to
 * bring it back.
 */
export function ConsentBanner(): ReactElement | null {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (ANALYTICS.posthog.kind === "off") return;
		if (readConsent() === null) setOpen(true);

		const reopen = () => setOpen(true);
		window.addEventListener(CONSENT_OPEN_EVENT, reopen);
		return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
	}, []);

	if (!open) return null;

	const choose = (consent: Consent) => {
		writeConsent(consent);
		setOpen(false);
	};

	return (
		<section
			aria-label="Cookie consent"
			className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-4 rounded-[var(--radius-group)] border border-hairline bg-surface p-5 sm:flex-row sm:items-center"
		>
			<p className="m-0 flex-1 text-ink-2 text-sm leading-relaxed">
				Can PostHog set a cookie and record how you use the docs? Visits are counted without cookies either way.{" "}
				<Link
					className="text-ink underline decoration-ink-2 underline-offset-4 hover:decoration-accent"
					hash="the-website"
					to={privacyRoute}
				>
					Privacy
				</Link>
			</p>
			<div className="flex shrink-0 gap-2">
				<button
					className={`${BUTTON} border border-hairline text-ink hover:border-ink`}
					onClick={() => choose("denied")}
					type="button"
				>
					Decline
				</button>
				<button
					className={`${BUTTON} bg-ink text-ground hover:bg-accent hover:text-ink`}
					onClick={() => choose("granted")}
					type="button"
				>
					Accept
				</button>
			</div>
		</section>
	);
}
