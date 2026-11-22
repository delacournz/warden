import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** The access control a demo item is written with (`SecAccessControlCreateFlags`). */
export type KeychainAcl = "currentSetOrPasscode" | "currentSet" | "any" | "passcode" | "userPresence";

/** What a read answered: the OSStatus, and the secret when it is `0`. */
export type KeychainRead = { status: number; value?: string };

type NativeKeychainAcl = {
	save(account: string, secret: string, acl: KeychainAcl): Promise<number>;
	read(account: string, noUI: boolean): Promise<KeychainRead>;
	readOnMain(account: string): Promise<KeychainRead>;
	remove(account: string): Promise<number>;
};

/** iOS only: Android has no `SecAccessControl`, so the screen says so instead of calling in. */
export const keychainAcl: NativeKeychainAcl | null =
	Platform.OS === "ios" ? requireOptionalNativeModule<NativeKeychainAcl>("KeychainAcl") : null;
