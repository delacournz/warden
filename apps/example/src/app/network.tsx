import { Showcase } from "@/modules/showcase/components/showcase";

/** Placeholder for the network showcase (WDN-SHOW). */
export default function NetworkShowcase() {
	return (
		<Showcase backTestID="net-back" testID="net-screen" title="Network">
			<Showcase.Body>{null}</Showcase.Body>
		</Showcase>
	);
}
