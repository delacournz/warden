import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Screen } from "@/components/ui/screen";
import { Steps } from "@/components/ui/steps";
import { Text } from "@/components/ui/text";
import { IconArrowRight } from "@/lib/icons/central";

const STEPS = [
	{ title: "Welcome", body: "A small Expo app built with Delacour UI, for testing warden end to end." },
	{ title: "Plan", body: "Keep a list of todos, tick them off and open each one." },
	{ title: "Test", body: "Every control carries a testID, so e2e flows stay deterministic." },
] as const;

/** Three-step onboarding; the last step's button goes to sign-in. */
export default function Welcome() {
	const [step, setStep] = useState(0);
	const current = STEPS[step] ?? STEPS[0];
	const isLast = step === STEPS.length - 1;

	return (
		<Screen testID="welcome-screen">
			<Screen.View className="flex-1 justify-center gap-8 px-6">
				<Steps onValueChange={setStep} value={step}>
					{STEPS.map((s, i) => (
						<Steps.Item key={s.title} step={i} testID={`welcome-step-${i}`}>
							{s.title}
						</Steps.Item>
					))}
				</Steps>
				<View className="gap-3">
					<Text.Title testID="welcome-title">{current.title}</Text.Title>
					<Text.Paragraph color="muted">{current.body}</Text.Paragraph>
				</View>
			</Screen.View>
			<Screen.Footer>
				<Button
					onPress={() => (isLast ? router.push("/sign-in") : setStep(step + 1))}
					testID={isLast ? "welcome-get-started" : "welcome-next"}
				>
					<Button.Label>{isLast ? "Get started" : "Next"}</Button.Label>
					<Icon icon={IconArrowRight} />
				</Button>
			</Screen.Footer>
		</Screen>
	);
}
