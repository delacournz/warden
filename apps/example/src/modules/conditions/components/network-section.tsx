import { useNetInfo } from "@react-native-community/netinfo";
import type { ReactElement } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useProbe } from "../hooks/use-probe";

/** Offline when NetInfo says the device is not connected or the internet is not reachable. */
export function OfflineBanner(): ReactElement | null {
	const { isConnected, isInternetReachable } = useNetInfo();
	if (isConnected !== false && isInternetReachable !== false) return null;
	return (
		<View accessible className="rounded-lg bg-danger px-4 py-3" testID="conditions-offline-banner">
			<Text.Label className="text-danger-foreground">You are offline</Text.Label>
		</View>
	);
}

/** NetInfo state and a Fetch button with its status, duration, attempts and error. */
export function NetworkSection(): ReactElement {
	const { isConnected, isInternetReachable, type } = useNetInfo();
	const { state, run } = useProbe();
	const result = state.phase === "done" ? state.result : null;

	let status = "idle";
	if (state.phase === "loading") status = "loading";
	else if (result) status = result.ok ? "success" : "error";

	return (
		<Card>
			<Card.Header>
				<Card.Title>Network</Card.Title>
			</Card.Header>
			<Card.Content className="gap-1">
				<View className="flex-row flex-wrap gap-x-3">
					<Text.Caption accessible testID="conditions-net-connected">
						{`connected: ${String(isConnected)}`}
					</Text.Caption>
					<Text.Caption accessible testID="conditions-net-reachable">
						{`reachable: ${String(isInternetReachable)}`}
					</Text.Caption>
					<Text.Caption accessible testID="conditions-net-type">
						{`type: ${type}`}
					</Text.Caption>
				</View>
				<Text.Label accessible testID="conditions-fetch-status">
					{status}
				</Text.Label>
				<View className="flex-row flex-wrap gap-x-3">
					<Text.Caption accessible testID="conditions-fetch-http">
						{result?.status === null || result === null ? "http: -" : `http: ${result.status}`}
					</Text.Caption>
					<Text.Caption accessible testID="conditions-fetch-duration">
						{result ? `duration: ${result.durationMs} ms` : "duration: -"}
					</Text.Caption>
					<Text.Caption accessible testID="conditions-fetch-attempts">
						{result ? `attempts: ${result.attempts}` : "attempts: -"}
					</Text.Caption>
				</View>
				<Text.Caption accessible testID="conditions-fetch-key">
					{result ? `key: ${result.key}` : "key: -"}
				</Text.Caption>
				<Text.Caption accessible testID="conditions-fetch-error">
					{result?.error ? `error: ${result.error}` : "error: -"}
				</Text.Caption>
			</Card.Content>
			<Card.Footer>
				<Button isDisabled={state.phase === "loading"} onPress={run} testID="conditions-fetch" variant="outline">
					Fetch
				</Button>
			</Card.Footer>
		</Card>
	);
}
