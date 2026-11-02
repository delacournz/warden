import { pricingRoute, privacyRoute } from "./shared";

/**
 * The warden cloud terms of service, as data. Inline code and links use the
 * two marks `rich-text.tsx` renders. Change `updated` with any edit.
 */
export type TermsSection = {
	id: string;
	title: string;
	body: readonly string[];
};

export const TERMS = {
	title: "Terms of service",
	description: "The terms for warden cloud, the hosted simulators and emulators run by Delacour Limited.",
	provider: "Delacour Limited",
	contact: "chris@delacour.co.nz",
	updated: "2026-10-31",
	lede: "These terms cover warden cloud, the hosted devices you reach with `warden login`. The warden CLI and its local simulators are open source and free; their licence is in the repository.",
} as const;

export const TERMS_SECTIONS: readonly TermsSection[] = [
	{
		id: "who-we-are",
		title: "Who we are",
		body: [
			`warden cloud is provided by ${TERMS.provider}, a company registered in New Zealand. Write to [${TERMS.contact}](mailto:${TERMS.contact}) about anything here.`,
			"By creating an account or using warden cloud you accept these terms.",
		],
	},
	{
		id: "business-use",
		title: "Business use only",
		body: [
			"warden cloud is for businesses. By using it you confirm you are acting for a business and acquire the service for business purposes.",
			"Where you acquire the service for business purposes, the Consumer Guarantees Act 1993 does not apply, to the extent permitted by law.",
		],
	},
	{
		id: "credits",
		title: "Prepaid credits",
		body: [
			`You pay in advance by topping up credit, and devices draw it down at the rate on the [pricing page](${pricingRoute}), billed per second. Prices exclude tax, and GST is added for customers in New Zealand.`,
			"Credits never expire. Credits are non-refundable, except where the law requires a refund.",
			"When your credit runs out your devices stop. We warn you shortly before, but you are responsible for watching your balance.",
		],
	},
	{
		id: "trial",
		title: "Free trial",
		body: [
			"New organizations get a small trial credit. It is one trial per person, and it is not granted on a machine already used for a trial or to a GitHub account that is too new. Trial credit has no cash value.",
		],
	},
	{
		id: "fair-use",
		title: "Fair use",
		body: [
			"Use hosted devices to build and test software. Do not use them for cryptocurrency mining, to attack or abuse other systems, to harm or overload the service, or to resell access.",
			"Do not get around trial limits, for example by making several accounts or using several machines for more than one trial per person.",
		],
	},
	{
		id: "suspension",
		title: "Suspension and closure",
		body: [
			"We may suspend or close an account, and stop its devices, for abuse, fraud, trial farming, a breach of these terms, or a payment dispute or chargeback.",
			"If a payment is disputed or charged back, we deduct the disputed amount from your balance and your devices stop.",
		],
	},
	{
		id: "availability",
		title: "No guarantee of availability",
		body: [
			"warden cloud is provided as is. We aim to keep it running but do not guarantee availability, and hosted devices can fail or be interrupted. Do not rely on a device for anything you cannot repeat.",
		],
	},
	{
		id: "liability",
		title: "Limit of liability",
		body: [
			"To the extent permitted by law, we are not liable for indirect or consequential loss, or for lost profit, revenue or data.",
			"Our total liability to you for anything arising from warden cloud is limited to the amount you paid us in the previous 3 months.",
		],
	},
	{
		id: "law",
		title: "Governing law",
		body: [
			"These terms are governed by New Zealand law, and the courts of New Zealand have jurisdiction over any dispute.",
		],
	},
	{
		id: "privacy",
		title: "Privacy",
		body: [`How we handle your information is in the [privacy policy](${privacyRoute}).`],
	},
	{
		id: "changes",
		title: "Changes",
		body: [
			"We may change these terms. When we do, the date at the top changes and we notify account holders by email before the change takes effect for material changes. Using warden cloud after that means you accept the new terms.",
		],
	},
];
