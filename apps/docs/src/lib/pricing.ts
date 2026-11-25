import { termsRoute } from "./shared";

/**
 * The pricing page, as data. Inline code and links use the two marks
 * `rich-text.tsx` renders.
 */
export type PricingSection = {
	id: string;
	title: string;
	body: readonly string[];
};

export const PRICING = {
	title: "Pricing",
	description:
		"warden cloud costs $0.20 per device-minute, billed per second, from prepaid credit that never expires. Local simulators and emulators stay free.",
	lede: "Local simulators and emulators with the warden CLI are free. warden cloud, the hosted devices you opt into with `warden login`, is pay as you go from prepaid credit.",
	ratePerMinuteUsd: 0.2,
	trialUsd: 2,
	topUpsUsd: [10, 20, 50],
	topUpRangeUsd: { min: 10, max: 500 },
} as const;

export const PRICING_SECTIONS: readonly PricingSection[] = [
	{
		id: "rate",
		title: "$0.20 per device-minute",
		body: [
			"A hosted device is billed per second, from the moment it starts to the moment it stops. Boot time counts. Prices are in US dollars.",
			"Local simulators and emulators run by the warden CLI on your own machine stay free.",
		],
	},
	{
		id: "free-trial",
		title: "$2 free trial credit",
		body: [
			"A new organization gets $2 of credit to try warden cloud. The trial is one per person, so it needs `warden login` on a machine and a GitHub account at least 30 days old.",
			"It is not granted on a machine that has already been used for a trial. A younger GitHub account still works with paid credit.",
		],
	},
	{
		id: "top-ups",
		title: "Prepaid top-ups",
		body: [
			"Top up with $10, $20 or $50, or a custom amount from $10 to $500, through Stripe Checkout. A $20 top-up adds $20 of credit.",
			"Credits never expire. When they run out, your devices stop, with a warning about 2 minutes before.",
		],
	},
	{
		id: "tax",
		title: "Tax",
		body: [
			"Prices exclude tax. Customers in New Zealand pay 15% GST on top. Overseas businesses are zero-rated, and we collect your tax ID at checkout.",
		],
	},
	{
		id: "commands",
		title: "From the command line",
		body: [
			"`warden billing` shows your balance, the rate and roughly how many minutes are left.",
			"`warden billing --top-up [amount]` opens Stripe Checkout for a top-up.",
			"`warden whoami` shows who you are logged in as and your organization.",
		],
	},
	{
		id: "terms",
		title: "Terms",
		body: [`warden cloud is for businesses and is prepaid. Read the full [terms of service](${termsRoute}).`],
	},
];
