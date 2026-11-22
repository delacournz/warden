import { IconKey1, IconLock } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useKeychain } from "@/modules/keychain/hooks/use-keychain";
import type { KeychainStatus } from "@/modules/keychain/utils/keychain-status";
import { Showcase } from "@/modules/showcase/components/showcase";

/** The headline and supporting line per status. */
const COPY: Record<KeychainStatus, { title: string; body: string }> = {
	Ready: { title: "Keychain", body: "Save a secret behind Face ID, then read it back." },
	Saved: { title: "Saved", body: "The secret is in the Keychain behind its access control." },
	Reading: { title: "Reading", body: "The Keychain asks for Face ID or the passcode." },
	Read: { title: "Read", body: "The Keychain handed the secret back." },
	Cancelled: { title: "Cancelled", body: "The prompt was dismissed (-128)." },
	"Needs UI": { title: "Needs UI", body: "The item needs a prompt and this read allowed none (-25308)." },
	Invalidated: { title: "Invalidated", body: "The item is bound to an enrolment that is gone (-25300)." },
	Failed: { title: "Failed", body: "The Keychain refused the call." },
	Deleted: { title: "Deleted", body: "Both demo items are gone." },
	Unavailable: { title: "iOS only", body: "Keychain access control is an iOS feature." },
};

/** Two actions side by side, each half the width, so the whole screen fits without scrolling. */
function Pair({ children }: { children: [ReactNode, ReactNode] }) {
	return (
		<View className="flex-row gap-3">
			<View className="flex-1">{children[0]}</View>
			<View className="flex-1">{children[1]}</View>
		</View>
	);
}

/**
 * Keychain items behind `SecAccessControl`, for the Keychain ACL shim's spec and screen recordings, on the shared
 * `Showcase` shell. Two items: `gate` (`.biometryCurrentSet | .or | .devicePasscode`, an app's usual secret) and `bio`
 * (`.biometryCurrentSet` alone). Reads are plain `SecItemCopyMatching`: the app never evaluates a policy itself, so any
 * prompt comes from the item's access control. The readout shows the values the spec asserts on (`kc-status`,
 * `kc-code` = the raw OSStatus, `kc-value`). Reachable from Settings or `warden-example://keychain` (no sign-in gate).
 * The pinned action reads the `gate` item.
 */
export default function Keychain() {
	const { status, code, value, save, read, remove } = useKeychain();
	const success = useThemeColor("success");
	const faint = useThemeColor("tertiary-foreground");
	const copy = COPY[status];
	const busy = status === "Reading" || status === "Unavailable";

	return (
		<Showcase
			backTestID="kc-back"
			testID="kc-screen"
			title="Keychain"
			trailing={<IconLock color={status === "Read" ? success : faint} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero
					body={copy.body}
					glyph={<IconKey1 color={status === "Read" ? success : faint} size={56} />}
					title={copy.title}
				/>
				<Showcase.Readout>
					<Showcase.Readout.Row label="status" testID="kc-status" value={status} />
					<Showcase.Readout.Row label="code" testID="kc-code" value={code} />
					<Showcase.Readout.Row label="value" testID="kc-value" value={value} />
				</Showcase.Readout>
				<Showcase.Section title="Face ID or passcode">
					<Pair>
						<Showcase.Action label="Save" onPress={() => save("gate")} testID="kc-save" variant="outline" />
						<Showcase.Action
							label="Read, no UI"
							onPress={() => read("gate", "no-ui")}
							testID="kc-read-no-ui"
							variant="outline"
						/>
					</Pair>
					<Pair>
						<Showcase.Action
							label="Read on main"
							onPress={() => read("gate", "main")}
							testID="kc-read-main"
							variant="outline"
						/>
						<Showcase.Action label="Delete both" onPress={remove} testID="kc-delete" variant="outline" />
					</Pair>
				</Showcase.Section>
				<Showcase.Section title="Current Face ID only">
					<Pair>
						<Showcase.Action label="Save" onPress={() => save("bio")} testID="kc-save-bio" variant="outline" />
						<Showcase.Action label="Read" onPress={() => read("bio", "plain")} testID="kc-read-bio" variant="outline" />
					</Pair>
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action
					label="Read secret"
					onPress={() => read("gate", "plain")}
					testID="kc-read"
					variant={busy ? "busy" : "solid"}
				/>
			</Showcase.Footer>
		</Showcase>
	);
}
