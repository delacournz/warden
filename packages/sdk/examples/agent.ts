/**
 * Let a model drive an app on a warden-claimed device with the Vercel AI SDK. Not run in tests (needs a model key).
 *
 *   AI_MODEL=anthropic/claude-sonnet-4.5 WARDEN_SDK_PLATFORM=ios WARDEN_SDK_APP=com.apple.Preferences \
 *     bun packages/sdk/examples/agent.ts "open Wi-Fi settings and tell me which network is joined"
 *
 * `AI_MODEL` is an AI Gateway model string ("provider/model").
 */
import { isStepCount, ToolLoopAgent } from "ai";
import { createWardenTools } from "../src/ai-sdk/tools";

const platform = process.env.WARDEN_SDK_PLATFORM === "android" ? "android" : "ios";
const app = process.env.WARDEN_SDK_APP ?? "com.apple.Preferences";
const model = process.env.AI_MODEL;
const task = process.argv[2] ?? "open the app and describe the first screen";

async function main(): Promise<void> {
	if (!model) throw new Error("set AI_MODEL to a gateway model string, e.g. anthropic/claude-sonnet-4.5");

	const warden = await createWardenTools({
		platform,
		app,
		set: "core",
		approval: { alert: "user-approval" },
		clientOptions: { lockPolicy: "wait" },
	});
	try {
		const agent = new ToolLoopAgent({
			model,
			instructions:
				"You drive a mobile app through tools. Call snapshot to see the screen, act with the @eN refs it returns, " +
				"and snapshot again after every action. If a tool returns ok:false, follow its hint.",
			tools: warden.tools,
			toolApproval: warden.toolApproval,
			stopWhen: isStepCount(20),
		});
		const result = await agent.generate({ prompt: task });
		console.log(result.text);
	} finally {
		await warden.close();
	}
}

await main();
