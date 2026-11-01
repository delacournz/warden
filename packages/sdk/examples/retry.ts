/**
 * Error handling of the docs (`client-api.mdx`): branch on `code`, retry only what is safe, cancel with an
 * AbortSignal.
 */
import { createWardenClient, isWardenError, type Session } from "../src/index";

/** Retry a call while the failure says the device was not touched (`dispatched: "no"`) and it can go away by itself. */
export async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await call();
		} catch (error) {
			const safe = isWardenError(error) && error.retryable === true && error.dispatched === "no";
			if (!safe || attempt >= attempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
		}
	}
}

/** Tap a ref; on `stale_ref` take a fresh snapshot and look the element up again by its label. */
export async function pressLabelled(session: Session, label: string): Promise<void> {
	const snap = await session.capture.snapshot({ interactiveOnly: true });
	const target = snap.elements.find((element) => element.label === label);
	if (!target) throw new Error(`no element labelled ${label}`);
	try {
		await session.interactions.press({ ref: target.ref });
	} catch (error) {
		if (!isWardenError(error) || error.code !== "stale_ref") throw error;
		const fresh = await session.query.find({ selector: `label=${JSON.stringify(label)}` });
		const again = fresh[0];
		if (!again) throw error;
		await session.interactions.press({ ref: again.ref });
	}
}

/** Give up on a claim after `ms`: the call rejects with `interrupted` and nothing stays leased. */
export async function canClaimWithin(ms: number): Promise<boolean> {
	await using warden = createWardenClient({ lockPolicy: "wait" });
	try {
		await warden.leases.claim({ platform: "android" }, { signal: AbortSignal.timeout(ms) });
		return true;
	} catch (error) {
		if (isWardenError(error) && error.code === "interrupted") return false;
		throw error;
	}
}
